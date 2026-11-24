import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createTextQuotaHandler, parseCodexTextQuota } from "../lib/text-quota.mjs";

const NOW = Date.UTC(2026, 10, 22, 12);
const WEEK = 7 * 24 * 3600;
const H5 = 5 * 3600;
const accountId = "secret-chatgpt-account-id";
function jwt(claims = {}) {
  const payload = { exp: NOW / 1000 + WEEK * 2, chatgpt_account_id: accountId, ...claims };
  return ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}
function row(i, fields = {}) {
  return { email: i + "@example.test", accessToken: jwt({ sub: String(i) }), password: "secret-password", ...fields };
}
function windowOf(seconds, used, reset = 3600) {
  return { limit_window_seconds: seconds, used_percent: used, reset_after_seconds: reset };
}
const usage = (short = 12, long = 60) => ({ rate_limit: {
  allowed: short < 100 && long < 100,
  limit_reached: short >= 100 || long >= 100,
  primary_window: windowOf(H5, short), secondary_window: windowOf(WEEK, long, 86400),
} });

async function invoke(handler, method, body, opts, request = { method }) {
  let status;
  let headers;
  let payload;
  await handler(request, {
    writeHead(code, head) { status = code; headers = head; },
    end(text) { payload = JSON.parse(text); },
  }, body, opts);
  return { status, headers, body: payload };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function manualTime() {
  let now = NOW;
  const waits = [];
  return {
    clock: () => now,
    waits,
    wait(ms) {
      const gate = deferred();
      waits.push({ ms, release: gate.release });
      return gate.promise;
    },
    resume(ms) {
      assert.equal(waits.length, 1);
      assert.equal(waits[0].ms, ms);
      now += ms;
      waits.shift().release();
    },
    advance(ms) { now += ms; },
  };
}

async function observe(handler, condition, pollMs = 0) {
  for (let i = 0; i < 100; i++) {
    const snapshot = (await invoke(handler, "GET")).body;
    if (condition(snapshot)) return snapshot;
    if (pollMs) await new Promise((resolve) => setTimeout(resolve, pollMs));
    else await new Promise(setImmediate);
  }
  assert.fail("expected quota job state was not reached");
}

test("Codex window lengths and availability come from account-wide usage only", () => {
  const result = parseCodexTextQuota({ ...usage(0, 103), code_review_rate_limit: usage(10, 50).rate_limit,
    credits: { balance: "300" }, plan_type: "never-return-this" }, NOW);
  assert.equal(result.status, "limited");
  assert.deepEqual(result.shortWindow, {
    status: "available", windowMinutes: 300, usedPercent: 0, resetAt: new Date(NOW + 3600_000).toISOString(),
  });
  assert.equal(result.longWindow.windowMinutes, 10080);
  assert.equal(result.longWindow.usedPercent, 103);
  assert.equal(result.longWindow.status, "limited");
  assert.doesNotMatch(JSON.stringify(result), /credits|never-return-this|balance/);

  const reset = NOW / 1000 + 60;
  const weekly = parseCodexTextQuota({ rate_limit: { allowed: true,
    primary_window: { ...windowOf(WEEK, 73, 999), reset_at: reset }, secondary_window: null,
  } }, NOW);
  assert.equal(weekly.status, "available");
  assert.equal(weekly.shortWindow, null);
  assert.equal(weekly.longWindow.resetAt, new Date(reset * 1000).toISOString(), "absolute reset wins");
  const reversed = parseCodexTextQuota({ rate_limit: {
    primary_window: windowOf(WEEK, 10), secondary_window: windowOf(H5, 30),
  } }, NOW);
  assert.equal(reversed.shortWindow.usedPercent, 30);
  assert.equal(reversed.longWindow.usedPercent, 10);

  const unknown = parseCodexTextQuota({ rate_limit: { primary_window: windowOf(H5, null) } }, NOW);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.shortWindow.usedPercent, null);
  assert.equal(unknown.shortWindow.status, "unknown");
  assert.equal(parseCodexTextQuota({ code_review_rate_limit: { limit_reached: true } }, NOW).status, "unknown");
  assert.equal(parseCodexTextQuota({ rate_limit: { limit_reached: true } }, NOW).status, "limited");
});

test("only explicit POST accesses fixed endpoint; snapshots expose no raw identifiers or credentials", async () => {
  const codex = row("Case", { email: "Case@Example.test" });
  const web = row("web", { accessToken: jwt({ chatgpt_account_id: undefined, client_id: "app_2SKx67EdpoN0G6j64rFvigXD" }) });
  const expired = row("expired", { accessToken: jwt({ exp: NOW / 1000 - 1 }) });
  let calls = 0;
  const handler = createTextQuotaHandler({ listAccounts: async () => [codex, web, expired], clock: () => NOW,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.get("authorization"), "Bearer " + codex.accessToken);
      assert.equal(options.headers.get("chatgpt-account-id"), accountId);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ ...usage(), email: codex.email, token: codex.accessToken });
    },
  });
  const opts = { idOf: (email) => email === codex.email ? "case-id" : "id-" + email.split("@")[0] };
  const before = await invoke(handler, "GET", undefined, opts);
  assert.equal(before.status, 200);
  assert.equal(before.headers["Cache-Control"], "no-store");
  assert.equal(calls, 0);
  assert.deepEqual(before.body.accounts.map(({ id, channel, status, reason }) => [id, channel, status, reason]), [
    ["case-id", "codex", "unknown", "not_checked"], ["id-web", "web", "unsupported", "web_unsupported"],
    ["id-expired", "codex", "unknown", "token_expired"],
  ]);
  const response = await invoke(handler, "POST", { email: "case@example.test" }, opts);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(response.body.refresh, { attempted: 1, deferred: 0 });
  assert.equal(response.body.accounts.length, 3);
  assert.equal(response.body.accounts[0].status, "available");
  assert.equal(response.body.accounts[0].shortWindow.usedPercent, 12);
  assert.doesNotMatch(JSON.stringify(response.body), /@|secret|signature|Bearer|password/);
  assert.deepEqual((await invoke(handler, "GET", undefined, opts)).body.accounts, response.body.accounts);
  assert.equal(calls, 1);
  assert.equal((await invoke(handler, "POST", { email: "absent@example.test" })).status, 404);
  assert.equal((await invoke(handler, "POST", { email: "web@example.test" })).body.refresh.attempted, 0);
  assert.equal((await invoke(handler, "POST", { email: "expired@example.test" })).body.refresh.attempted, 0);
});

test("one batch POST runs all eligible accounts across paced batches and is single-flight", async () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => row(i)),
    row("web", { accessToken: jwt({ chatgpt_account_id: undefined, client_id: "app_2SKx67EdpoN0G6j64rFvigXD" }) }),
    row("expired", { accessToken: jwt({ exp: NOW / 1000 - 1 }) }),
    row("opaque", { accessToken: "mock-opaque-token" }),
  ];
  const time = manualTime();
  const releaseFirst = deferred();
  const tokens = [];
  let inFlight = 0;
  let peak = 0;
  const handler = createTextQuotaHandler({ ...time, listAccounts: () => rows,
    fetcher: async (url, { headers }) => {
      tokens.push(headers.get("authorization"));
      peak = Math.max(peak, ++inFlight);
      try { await releaseFirst.promise; return Response.json(usage()); }
      finally { inFlight--; }
    },
  });
  const first = await invoke(handler, "POST", {});
  assert.equal(first.status, 202);
  assert.equal(first.body.job.attempted, 0);
  assert.equal(first.body.job.total, 9);
  assert.equal(first.body.job.unsupported, 1);
  assert.equal(first.body.job.needsRenew, 1);
  assert.equal(first.body.job.unavailable, 1);
  assert.equal(first.body.accounts[0].reason, "not_checked");
  const running = await observe(handler, ({ job }) => job.inFlight === 3);
  assert.equal(running.job.id, first.body.job.id);
  assert.equal(tokens.length, 3);
  const duplicate = await invoke(handler, "POST", {});
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.job.id, first.body.job.id);
  assert.equal((await invoke(handler, "POST", { email: rows[8].email })).body.reason, "refresh_in_progress");
  releaseFirst.release();
  const pause = await observe(handler, ({ job }) => job.state === "paused");
  assert.equal(pause.job.retryAt, new Date(NOW + 3000).toISOString());
  assert.equal(pause.job.completed, 6);
  assert.equal(tokens.length, 6);
  assert.equal(pause.accounts[6].reason, "not_checked");
  time.resume(3000);
  const end = await observe(handler, ({ job }) => job.state === "completed");
  assert.deepEqual({ ...end.job, id: undefined }, {
    id: undefined, state: "completed", total: 9, completed: 9,
    attempted: 9, inFlight: 0, retries: 0, retryAt: null, reason: null,
    succeeded: 9, failed: 0, skipped: 0, needsRenew: 1, unsupported: 1, unavailable: 1,
    startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 3000).toISOString(),
  });
  assert.equal(peak, 3);
  assert.deepEqual(new Set(tokens), new Set(rows.slice(0, 9).map((row) => "Bearer " + row.accessToken)));
  assert.equal(end.accounts[11].reason, "token_unverified");
  assert.doesNotMatch(JSON.stringify(end), /example\.test|secret|Bearer/);
  time.advance(3001);
  const third = await invoke(handler, "POST", { email: rows[1].email });
  assert.equal(third.status, 429);
  assert.equal(third.body.reason, "account_cooldown");
  assert.equal(Number(third.headers["Retry-After"]), third.body.retryAfterSeconds);
});

test("usage 429 honors HTTP-date and delta Retry-After and retries only once", async () => {
  const rows = [row(0), row(1), row(2)];
  const time = manualTime();
  const tokens = [];
  const httpDate = new Date(NOW + 1_200_000).toUTCString(); // No 15-minute truncation.
  const handler = createTextQuotaHandler({ ...time, listAccounts: () => rows, concurrency: 1,
    fetcher: (url, { headers }) => {
      const token = headers.get("authorization");
      tokens.push(token);
      if (token.endsWith(rows[2].accessToken)) return new Response(null, { status: 401 });
      if (!token.endsWith(rows[0].accessToken)) return Response.json(usage());
      return Response.json({ detail: "secret-upstream-description", rate_limit: { limit_reached: true } },
        { status: 429, headers: { "Retry-After": tokens.length === 1 ? httpDate : "5" } });
    },
  });
  assert.equal((await invoke(handler, "POST", {})).status, 202);
  const outcome = await observe(handler, ({ job }) => job.state === "paused");
  assert.equal(outcome.job.attempted, 1);
  assert.equal(outcome.job.completed, 0);
  assert.equal(outcome.job.retries, 0);
  assert.equal(outcome.job.retryAt, new Date(NOW + 1_200_000).toISOString());
  assert.equal(outcome.accounts[0].status, "unknown");
  assert.equal(outcome.accounts[0].reason, "upstream_throttled");
  assert.equal(outcome.accounts[0].longWindow, null);
  assert.doesNotMatch(JSON.stringify(outcome), /secret-upstream/);
  const retry = await invoke(handler, "POST", { email: rows[1].email });
  assert.equal(retry.status, 429);
  assert.equal(retry.body.retryAfterSeconds, 1200);
  assert.equal(tokens.length, 1);
  time.resume(1_200_000);
  const secondPause = await observe(handler, ({ job }) => job.state === "paused" && job.retries === 1);
  assert.equal(secondPause.job.retryAt, new Date(NOW + 1_205_000).toISOString());
  assert.equal(secondPause.job.completed, 1);
  assert.equal(secondPause.job.failed, 1);
  assert.equal(tokens.length, 2);
  time.resume(5000);
  const end = await observe(handler, ({ job }) => job.state === "completed");
  assert.equal(end.job.succeeded, 1);
  assert.equal(end.job.failed, 2);
  assert.equal(end.job.completed, 3);
  assert.equal(end.job.attempted, 4);
  assert.equal(end.job.retries, 1);
  assert.deepEqual(end.accounts.map(({ reason }) => reason), ["upstream_throttled", null, "upstream_unauthorized"]);
});

test("credentials removed, replaced, or expired while paused are not sent", async () => {
  const time = manualTime();
  let rows = [row(0), row(1), row(2, { accessToken: jwt({ exp: NOW / 1000 + 122 }) }), row(3)];
  const sent = [];
  const handler = createTextQuotaHandler({ ...time, maxBatch: 1, listAccounts: () => rows,
    fetcher: (url, { headers }) => { sent.push(headers.get("authorization")); return Response.json(usage()); },
  });
  await invoke(handler, "POST", {});
  await observe(handler, ({ job }) => job.state === "paused");
  rows = [rows[0], row(1, { accessToken: jwt({ sub: "replacement" }) }), rows[2]];
  time.resume(3000);
  const { accounts, job } = await observe(handler, ({ job }) => job.state === "completed");
  assert.equal(job.succeeded, 1);
  assert.equal(job.skipped, 3);
  assert.equal(job.completed, 4);
  assert.equal(job.needsRenew, 1);
  assert.deepEqual(sent, ["Bearer " + rows[0].accessToken]);
  assert.equal(accounts[1].reason, "not_checked");
  assert.equal(accounts[2].reason, "token_expired");
});

test("service shutdown cancels an in-flight background request", async () => {
  const controller = new AbortController();
  const starts = deferred();
  let upstreamSignal;
  const handler = createTextQuotaHandler({ signal: controller.signal, listAccounts: () => [row(1), row(2)], concurrency: 1,
    fetcher: (url, { signal }) => {
      upstreamSignal = signal;
      starts.release();
      return new Promise(() => {});
    },
  });
  assert.equal((await invoke(handler, "POST", {})).status, 202);
  await starts.promise;
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual((await invoke(handler, "GET")).body, { ok: false, reason: "service_closed" });
});


test("hard deadline bounds ignored abort and stalled body, malformed input is safe", async () => {
  const signals = [];
  let cancelled = false;
  const handler = createTextQuotaHandler({ listAccounts: () => [row(1), row(2)], clock: () => NOW, timeoutMs: 30,
    fetcher: (url, { headers, signal }) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise(() => {}) :
        new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    },
  });
  const blank = new PassThrough();
  blank.method = "POST";
  blank.end();
  assert.equal((await invoke(handler, "POST", undefined, undefined, blank)).status, 202);
  const timeout = await observe(handler, ({ job }) => job.state === "completed", 5);
  assert.deepEqual(timeout.accounts.map((x) => x.reason), ["timeout", "timeout"]);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.ok(cancelled);
  assert.equal((await invoke(handler, "POST", { email: 25 })).status, 400);
  assert.equal((await invoke(handler, "POST", { url: "https://example.test" })).status, 400);
  const malformed = new PassThrough();
  malformed.method = "POST";
  malformed.end("invalid JSON with a secret");
  const invalid = await invoke(handler, "POST", undefined, undefined, malformed);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.reason, "invalid_body");
});

test("elapsed windows become unknown; replacement credentials cannot inherit prior quota", async () => {
  let now = NOW;
  let account = row(1);
  const handler = createTextQuotaHandler({ listAccounts: () => [account], clock: () => now, staleAfterMs: 7_200_000,
    fetcher: () => Response.json(usage(100, 100)),
  });
  assert.equal((await invoke(handler, "POST", { email: account.email })).body.accounts[0].status, "limited");
  now += 3_600_001;
  const afterReset = (await invoke(handler, "GET")).body.accounts[0];
  assert.equal(afterReset.stale, true);
  assert.equal(afterReset.shortWindow.status, "unknown");
  assert.equal(afterReset.longWindow.status, "limited");
  assert.equal(afterReset.status, "limited");
  now += 3_600_001;
  assert.equal((await invoke(handler, "GET")).body.accounts[0].status, "unknown");
  account = { ...account, accessToken: jwt({ chatgpt_account_id: "different-workspace" }) };
  const replaced = (await invoke(handler, "GET")).body.accounts[0];
  assert.equal(replaced.reason, "not_checked");
  assert.equal(replaced.longWindow, null);
});

test("transient refresh failures keep the last known quota as history until a successful probe", async () => {
  const time = manualTime();
  let account = row(1);
  const results = [
    () => Response.json(usage(100, 60)),
    () => { throw new Error("offline"); },
    () => new Response(null, { status: 503 }),
    () => Response.json(usage(10, 20)),
    () => new Response(null, { status: 401 }),
  ];
  const handler = createTextQuotaHandler({ listAccounts: () => [account], clock: time.clock,
    refreshGapMs: 1, accountGapMs: 1, fetcher: () => results.shift()(),
  });
  const refresh = async () => (await invoke(handler, "POST", { email: account.email })).body.accounts[0];
  const known = await refresh();
  assert.equal(known.status, "limited");
  for (const reason of ["network_error", "upstream_unavailable"]) {
    time.advance(10);
    const history = await refresh();
    assert.equal(history.status, "unknown");
    assert.equal(history.reason, reason);
    assert.equal(history.stale, true);
    assert.equal(history.checkedAt, known.checkedAt);
    assert.equal(history.attemptedAt, new Date(time.clock()).toISOString());
    assert.deepEqual(history.shortWindow, { ...known.shortWindow, status: "unknown" });
    assert.deepEqual(history.longWindow, { ...known.longWindow, status: "unknown" });
    assert.deepEqual((await invoke(handler, "GET")).body.accounts[0], history);
  }
  time.advance(10);
  const fresh = await refresh();
  assert.equal(fresh.status, "available");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.shortWindow.usedPercent, 10);
  time.advance(10);
  const denied = await refresh();
  assert.equal(denied.reason, "upstream_unauthorized");
  assert.equal(denied.shortWindow, null);
});
