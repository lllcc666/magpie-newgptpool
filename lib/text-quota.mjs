import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fetchCodexTextUsage, isWebOnlyToken } from "./codex-pool.mjs";
import { accessTokenState } from "./credentials.mjs";
import { listPool } from "./pool-vault.mjs";

const POOL_CAP = 1000; // encrypted vault's maximum
const POST_BYTES = 4096;
const USAGE_BYTES = 128 * 1024;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_WINDOW_SECONDS = 366 * DAY_SECONDS;
const BODY_TIMEOUT_MS = 2_000;
const IO_TIMEOUT = Symbol("timeout");
const SERVICE_CLOSED = Symbol("service_closed");
const TRANSIENT_FAILURES = new Set(["timeout", "network_error", "upstream_throttled", "upstream_unavailable"]);
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DATE_MS = 8_640_000_000_000_000;

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const validNumber = (value, min, max) => typeof value === "number" &&
  Number.isFinite(value) && value >= min && value <= max;
const iso = (ms) => new Date(ms).toISOString();

function parseWindow(value, checkedMs) {
  if (!isObject(value) || !validNumber(value.limit_window_seconds, 1, MAX_WINDOW_SECONDS)) return null;
  // At or above 100% is limited.
  const usedPercent = validNumber(value.used_percent, 0, 1_000_000) ? value.used_percent : null;
  // The absolute value is Unix seconds; use the upstream relative value only as fallback.
  const resetAt = validNumber(value.reset_at, 1, Math.floor(checkedMs / 1000) + MAX_WINDOW_SECONDS)
    ? iso(value.reset_at * 1000)
    : validNumber(value.reset_after_seconds, 0, MAX_WINDOW_SECONDS)
      ? iso(checkedMs + value.reset_after_seconds * 1000) : null;
  return {
    usedPercent,
    windowMinutes: value.limit_window_seconds / 60,
    resetAt,
    status: usedPercent === null ? "unknown" : usedPercent >= 100 ? "limited" : "available",
  };
}

/** Only account text rate_limit, not credits, code-review or model-specific limits. */
export function parseCodexTextQuota(payload, checkedMs = Date.now()) {
  const rate = payload?.rate_limit;
  const windows = isObject(rate) ? [rate.primary_window, rate.secondary_window] : [];
  const observed = windows.map((value) => parseWindow(value, checkedMs));
  // Primary is not synonymous with short: for example, a weekly-only plan can report
  // its long window as primary. Use actual durations, not deployment/tier guesses.
  const ordered = observed.filter(Boolean).sort((a, b) => a.windowMinutes - b.windowMinutes);
  let shortWindow = null;
  let longWindow = null;
  if (ordered.length === 2 && ordered[0].windowMinutes !== ordered[1].windowMinutes) {
    [shortWindow, longWindow] = ordered;
  } else if (ordered.length) {
    const window = ordered.find((entry) => entry.status === "limited") ?? ordered[0];
    if (window.windowMinutes * 60 <= DAY_SECONDS) shortWindow = window;
    else longWindow = window;
  }
  const limited = rate?.limit_reached === true || rate?.allowed === false ||
    ordered.some((window) => window.status === "limited");
  const available = rate?.allowed === true || (!limited &&
    ordered.some((window) => window.status === "available") &&
    windows.every((entry, i) => entry == null || observed[i]?.status === "available"));
  const status = limited ? "limited" : available ? "available" : "unknown";
  return {
    status, reason: status === "unknown" ? "quota_unavailable" : null,
    checkedAt: iso(checkedMs), shortWindow, longWindow,
  };
}

function blank(status, reason, checkedAt = null) {
  return { status, reason, checkedAt, shortWindow: null, longWindow: null };
}

function eligibility(token, nowMs) {
  if (!token) return { channel: "unknown", reason: "token_missing" };
  if (isWebOnlyToken(token)) return { channel: "web", reason: "web_unsupported" };
  switch (accessTokenState(token, nowMs).state) {
    case "unexpired_unverified": return { channel: "codex", reason: null };
    case "expired": return { channel: "codex", reason: "token_expired" };
    case "not_yet_valid": return { channel: "codex", reason: "token_not_yet_valid" };
    default: return { channel: "unknown", reason: "token_unverified" };
  }
}

async function withDeadline(work, ms, lifecycle) {
  if (lifecycle?.aborted) throw SERVICE_CLOSED;
  const controller = new AbortController();
  let timer;
  let onClose;
  try {
    const expired = new Promise((_, reject) => {
      function stop(reason) {
        // Race even an injected transport that neglects to handle AbortSignal.
        reject(reason);
        controller.abort();
      }
      onClose = () => stop(SERVICE_CLOSED);
      lifecycle?.addEventListener("abort", onClose, { once: true });
      timer = setTimeout(() => stop(IO_TIMEOUT), ms);
    });
    return await Promise.race([expired, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw SERVICE_CLOSED;
      return work(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    lifecycle?.removeEventListener("abort", onClose);
  }
}

async function usageJSON(response, signal) {
  if (Number(response.headers?.get("content-length")) > USAGE_BYTES) {
    void response.body?.cancel?.()?.catch?.(() => {});
    throw new Error("body too large");
  }
  // A native fetch response always has a Web stream for a nonempty 200 body.
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const stop = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > USAGE_BYTES) {
        stop();
        throw new Error("body too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

function retryAfterMs(response, nowMs, fallbackMs, minMs) {
  const value = response.headers?.get("retry-after")?.trim();
  if (!value) return fallbackMs;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000
    : /^[a-z]{3}.*\d{2}:\d{2}:\d{2}/i.test(value) ? Date.parse(value) - nowMs : NaN;
  return Number.isFinite(ms) && nowMs + ms <= MAX_DATE_MS
    ? Math.max(minMs, ms) : fallbackMs;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    function finish(code, value = undefined) {
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("close", onClose);
      req.removeListener("error", onClose);
      if (code) reject(code);
      else resolve(value);
    }
    function onData(chunk) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > POST_BYTES) finish(413);
      else chunks.push(buffer);
    }
    function onEnd() {
      try {
        finish(0, size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch { finish(400); }
    }
    function onClose() { finish(400); }
    const timer = setTimeout(() => finish(408), BODY_TIMEOUT_MS);
    if (Number(req.headers?.["content-length"]) > POST_BYTES) {
      finish(413);
      req.resume();
    } else if (req.readableEnded) finish(0, {});
    else {
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("close", onClose);
      req.on("error", onClose);
    }
  });
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers,
  });
  res.end(JSON.stringify(data));
}

const bounded = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
const emailKey = (value) => typeof value === "string" && value.length <= 320 &&
  /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : "";

/** Instantiate once per authenticated GUI service. GET is upstream-free. POST is opt-in. */
export function createTextQuotaHandler({
  listAccounts = listPool, fetcher = fetch, clock = Date.now, signal,
  wait = (ms, abort) => delay(ms, undefined, { signal: abort, ref: false }),
  timeoutMs = 5_000, maxBatch = 6, concurrency = 3,
  refreshGapMs = 3_000, accountGapMs = 60_000, staleAfterMs = 15 * 60_000,
} = {}) {
  const deadline = bounded(timeoutMs, 1, 5_000, 5_000);
  const batchCap = bounded(maxBatch, 1, 6, 6);
  const parallel = bounded(concurrency, 1, 3, 3);
  const globalGap = bounded(refreshGapMs, 1, 60_000, 3_000);
  const accountGap = bounded(accountGapMs, 1, 900_000, 60_000);
  const staleAfter = bounded(staleAfterMs, 1, 24 * 60 * 60_000, 15 * 60_000);
  const idKey = randomBytes(32);
  const localId = (email) => createHmac("sha256", idKey).update(email).digest("hex").slice(0, 32);
  const cache = new Map();
  let job = null;
  let singleFlight = null;
  let nextRefresh = 0;

  const active = () => job?.state === "running" || job?.state === "paused";
  const readyAt = (account) => {
    const saved = cache.get(account.email);
    return saved?.binding === account.binding ? saved.readyAt : 0;
  };


  function accountsOf(rows, nowMs) {
    const accounts = new Map();
    for (const row of rows.slice(0, POOL_CAP)) {
      const email = emailKey(row?.email);
      if (!email || accounts.has(email)) continue;
      const accessToken = typeof row.accessToken === "string" && row.accessToken.length <= 8192
        ? row.accessToken : "";
      // Do not attach a snapshot from a previous login/workspace to replacement credentials.
      const binding = accessToken ? createHash("sha256").update(accessToken).digest("hex") : "";
      accounts.set(email, { email, identityEmail: row.email, accessToken, binding, ...eligibility(accessToken, nowMs) });
    }
    return accounts;
  }

  function view(account, idOf, nowMs) {
    const previous = cache.get(account.email);
    const saved = previous?.binding === account.binding ? previous.value : null;
    let result = account.reason ? blank(account.channel === "web" ? "unsupported" : "unknown", account.reason)
      : saved ?? blank("unknown", "not_checked");
    let stale = false;
    if (!account.reason && TRANSIENT_FAILURES.has(saved?.reason) && previous.lastGood) {
      // A failed probe is not evidence that the previously observed windows disappeared.
      // Expose them only as history, without counting them as current quota.
      const historical = (window) => window ? { ...window, status: "unknown" } : null;
      return { id: accountIdOf(account, idOf), channel: account.channel, ...saved,
        checkedAt: previous.lastGood.checkedAt, attemptedAt: saved.checkedAt, stale: true,
        shortWindow: historical(previous.lastGood.shortWindow), longWindow: historical(previous.lastGood.longWindow) };
    }
    if (!account.reason && saved) {
      const elapsed = nowMs - Date.parse(saved.checkedAt) >= staleAfter;
      for (const key of ["shortWindow", "longWindow"]) {
        const window = saved[key];
        if (window && (elapsed || (window.resetAt !== null && Date.parse(window.resetAt) <= nowMs))) {
          stale = true;
          result = { ...result, [key]: { ...window, status: "unknown" } };
        }
      }
      stale ||= elapsed;
      if (stale) {
        const stillLimited = [result.shortWindow, result.longWindow].some((w) => w?.status === "limited");
        result = { ...result, status: stillLimited ? "limited" : "unknown", reason: stillLimited ? null : "stale" };
      }
    }
    return { id: accountIdOf(account, idOf), channel: account.channel, ...result, stale };
  }

  function accountIdOf(account, idOf) {
    const candidate = idOf(account.identityEmail);
    // Reject clearly non-opaque values (raw email, whitespace, etc.) from an integrator.
    return typeof candidate === "string" && /^[\w-]{1,128}$/.test(candidate) ? candidate : localId(account.email);
  }

  async function readAccounts() {
    const rows = await withDeadline(() => listAccounts(), deadline, signal);
    if (!Array.isArray(rows)) throw new Error("invalid pool");
    return accountsOf(rows, clock());
  }

  const poolError = (err) => err === IO_TIMEOUT ? "pool_timeout"
    : err === SERVICE_CLOSED || signal?.aborted ? "service_closed" : "pool_unavailable";

  async function probe(account) {
    const unknown = (reason) => blank("unknown", reason, iso(clock()));
    try {
      return await withDeadline(async (abort) => {
        const response = await fetchCodexTextUsage(account, { fetcher, signal: abort });
        const status = response?.status;
        if (!response?.ok) {
          void response?.body?.cancel?.()?.catch?.(() => {});
          if (status === 429) {
            // Throttling the usage API is not text-window exhaustion. Pause all quota probes.
            const t = clock();
            if (!abort.aborted) nextRefresh = Math.max(nextRefresh, t + retryAfterMs(response, t, Math.max(accountGap, globalGap), globalGap));
            return unknown("upstream_throttled");
          }
          if (status === 401 || status === 403) return unknown("upstream_unauthorized");
          return unknown("upstream_unavailable");
        }
        let payload;
        try { payload = await usageJSON(response, abort); } catch { return unknown("invalid_response"); }
        return isObject(payload) ? parseCodexTextQuota(payload, clock()) : unknown("invalid_response");
      }, deadline, signal);
    } catch (err) {
      return unknown(err === IO_TIMEOUT ? "timeout" : err === SERVICE_CLOSED ? "service_closed" : "network_error");
    }
  }

  function saveProbe(account, value, willRetry = false) {
    const retryAt = value.reason === "upstream_throttled" ? nextRefresh : 0;
    const previous = cache.get(account.email);
    const lastGood = value.status !== "unknown" ? value
      : TRANSIENT_FAILURES.has(value.reason) && previous?.binding === account.binding ? previous.lastGood : null;
    cache.set(account.email, {
      binding: account.binding, value, lastGood,
      readyAt: willRetry ? retryAt : Math.max(retryAt, clock() + accountGap),
    });
  }

  function finish(current, reason = null) {
    Object.assign(current, {
      state: reason ? "failed" : "completed", retryAt: null, finishedAt: iso(clock()), reason,
    });
  }

  function settle(current, pending, entry, result) {
    pending.delete(entry.email);
    current.completed++;
    current[result]++;
  }

  // Store no token in the pending queue; re-read the pool after throttling and
  // before each dispatch batch so removed/replaced credentials are not reused.
  async function runJob(current, pending) {
    try {
      await singleFlight;
      while (pending.size) {
        if (signal?.aborted) throw SERVICE_CLOSED;
        if (clock() < nextRefresh) {
          current.state = "paused";
          current.retryAt = iso(nextRefresh);
          await wait(Math.min(MAX_TIMER_MS, nextRefresh - clock()), signal);
          continue;
        }

        const accounts = await readAccounts();
        let nextAccount = Infinity;
        const selected = [];
        for (const entry of pending.values()) {
          const account = accounts.get(entry.email);
          if (!account || account.binding !== entry.binding || account.reason) {
            if (account?.binding === entry.binding && account.reason === "token_expired") current.needsRenew++;
            settle(current, pending, entry, "skipped");
          } else if (readyAt(account) > clock()) {
            nextAccount = Math.min(nextAccount, readyAt(account));
          } else if (selected.length < batchCap) {
            selected.push({ account, entry });
          }
        }
        if (!selected.length) {
          if (!pending.size) break;
          current.state = "paused";
          current.retryAt = iso(nextAccount);
          await wait(Math.min(MAX_TIMER_MS, Math.max(0, nextAccount - clock())), signal);
          continue;
        }

        current.state = "running";
        current.retryAt = null;
        let cursor = 0;
        const before = current.attempted;
        async function worker() {
          while (cursor < selected.length && !signal?.aborted && clock() >= nextRefresh) {
            const { account, entry } = selected[cursor++];
            // An expiry can cross during earlier requests in this same batch.
            if (eligibility(account.accessToken, clock()).reason === "token_expired") {
              current.needsRenew++;
              settle(current, pending, entry, "skipped");
              continue;
            }
            if (entry.retried) current.retries++;
            current.attempted++;
            current.inFlight++;
            try {
              const value = await probe(account);
              if (signal?.aborted) return;
              const retry = value.reason === "upstream_throttled" && !entry.retried;
              saveProbe(account, value, retry);
              if (retry) entry.retried = true;
              else settle(current, pending, entry, value.status === "unknown" ? "failed" : "succeeded");
            } finally {
              current.inFlight--;
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(parallel, selected.length) }, worker));
        if (current.attempted > before) nextRefresh = Math.max(nextRefresh, clock() + globalGap);
      }
      finish(current);
    } catch (err) {
      finish(current, poolError(err));
    }
  }


  function limited(res, reason, until = clock() + 1000) {
    const retryAfterSeconds = Math.max(1, Math.ceil((until - clock()) / 1000));
    return send(res, 429, { ok: false, reason, retryAfterSeconds }, { "Retry-After": String(retryAfterSeconds) });
  }

  return async function handleTextQuota(req, res, parsedBody, { idOf = localId, targetField = "email" } = {}) {
    if (req.method !== "GET" && req.method !== "POST") {
      return send(res, 405, { ok: false, reason: "method_not_allowed" }, { Allow: "GET, POST" });
    }
    let target = "";
    if (req.method === "POST") {
      let body = parsedBody;
      try { if (body === undefined) body = await readRequestBody(req); }
      catch (code) {
        const reason = code === 413 ? "body_too_large" : code === 408 ? "body_timeout" : "invalid_body";
        return send(res, code, { ok: false, reason }, code === 400 ? {} : { Connection: "close" });
      }
      const validTarget = (value) => targetField === "id"
        ? (typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : "")
        : emailKey(value);
      if (!isObject(body) || Object.keys(body).some((key) => key !== targetField) ||
          (Object.hasOwn(body, targetField) && !(target = validTarget(body[targetField])))) {
        return send(res, 400, { ok: false, reason: "invalid_body" });
      }
    }
    let accounts;
    try { accounts = await readAccounts(); }
    catch (err) { return send(res, 503, { ok: false, reason: poolError(err) }); }
    if (signal?.aborted) return send(res, 503, { ok: false, reason: "service_closed" });
    const snapshot = () => {
      const t = clock();
      return [...accounts.values()].map((account) => view(account, idOf, t));
    };
    if (req.method === "GET") return send(res, 200, { ok: true, accounts: snapshot(), job });
    for (const email of cache.keys()) if (!accounts.has(email)) cache.delete(email);

    if (!target) {
      if (active()) return send(res, 202, { ok: true, accounts: snapshot(), job });
      const pending = new Map();
      let unsupported = 0;
      let needsRenew = 0;
      let unavailable = 0;
      for (const { email, binding, reason } of accounts.values()) {
        if (reason === "web_unsupported") unsupported++;
        else if (reason === "token_expired") needsRenew++;
        else if (reason) unavailable++;
        else pending.set(email, { email, binding, retried: false });
      }
      const current = job = {
        id: randomBytes(16).toString("hex"), state: "running", total: pending.size,
        completed: 0, succeeded: 0, failed: 0, skipped: 0, needsRenew, unsupported, unavailable,
        attempted: 0, inFlight: 0, retries: 0, retryAt: null,
        startedAt: iso(clock()), finishedAt: null, reason: null,
      };
      if (!pending.size) finish(current);
      send(res, 202, { ok: true, accounts: snapshot(), job: current });
      if (pending.size) void runJob(current, pending);
      return;
    }

    const account = targetField === "id"
      ? [...accounts.values()].find((item) => accountIdOf(item, idOf) === target)
      : accounts.get(target);
    if (!account) return send(res, 404, { ok: false, reason: "account_not_found" });
    let attempted = 0;
    if (!account.reason) {
      const nowMs = clock();
      if (active() || singleFlight) {
        return limited(res, "refresh_in_progress", job?.retryAt ? Date.parse(job.retryAt) : undefined);
      }
      if (nowMs < nextRefresh) return limited(res, "refresh_cooldown", nextRefresh);
      const ready = readyAt(account);
      if (nowMs < ready) return limited(res, "account_cooldown", ready);
      attempted = 1;
      singleFlight = (async () => {
        const value = await probe(account);
        if (!signal?.aborted) saveProbe(account, value);
        nextRefresh = Math.max(nextRefresh, clock() + globalGap);
      })();
      try { await singleFlight; }
      finally { singleFlight = null; }
    }
    if (signal?.aborted) return send(res, 503, { ok: false, reason: "service_closed" });
    return send(res, 200, { ok: true, accounts: snapshot(), refresh: { attempted, deferred: 0 } });
  };
}
