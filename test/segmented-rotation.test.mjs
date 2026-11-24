import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BASE, createSegmentedTextRotation, poolFetch, selectPoolOrder, textConversationKey,
} from "../lib/codex-pool.mjs";
import { clearTextCooldowns } from "../lib/chatgpt-web-text.mjs";
import {
  DEFAULT_POOL_POLICY, ROTATION_STRATEGIES, readPoolPolicy, writePoolPolicy,
} from "../lib/pool-policy.mjs";
import { createInMemoryStatsStore, recordTextCall } from "../lib/pool-stats.mjs";

let root;
const savedHome = process.env.MAGPIE_GPTFREE_HOME;
const savedFetch = globalThis.fetch;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "segmented-rotation-test-"));
  process.env.MAGPIE_GPTFREE_HOME = root;
  globalThis.fetch = () => { throw new Error("Live fetch is forbidden in this suite"); };
  await writePoolPolicy({ rotation: { strategy: "segmented" } });
});
after(async () => {
  if (savedHome === undefined) delete process.env.MAGPIE_GPTFREE_HOME;
  else process.env.MAGPIE_GPTFREE_HOME = savedHome;
  globalThis.fetch = savedFetch;
  clearTextCooldowns();
  if (root) await rm(root, { recursive: true, force: true });
});

function account(name, { web = false, expired = false } = {}) {
  const email = name + "@example.invalid";
  const exp = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
  const client_id = web ? "app_2SKx67EdpoN0G6j64rFvigXD" : "app_EMoamEEZ73f0CkXaXp7hrann";
  const claims = web ? { exp, client_id, email } : { exp, client_id, "https://api.openai.com/auth": { chatgpt_account_id: name } };
  const accessToken = "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".synthetic";
  return { name, email, accessToken };
}

function fixture(accounts = [account("A"), account("B"), account("C")]) {
  const textRotation = createSegmentedTextRotation();
  const statsStore = createInMemoryStatsStore();
  const attempts = [];
  const options = {
    read: async () => accounts,
    statsStore,
    textRotation,
    reauthenticate: async () => { throw new Error("Unexpected synthetic reauth"); },
    fetcher: async (_, init) => {
      const name = init.headers.get("chatgpt-account-id");
      attempts.push(name);
      return new Response(name);
    },
    webTextRunner: async (payload) => {
      const name = accounts.find((a) => a.accessToken === payload.access_token)?.name;
      attempts.push(name);
      return { ok: true, text: name };
    },
  };
  return {
    attempts, options,
    async turn(body = {}, headers) {
      const r = await poolFetch(CODEX_BASE + "/responses", {
        body: JSON.stringify({ model: "gpt-6", input: "synthetic only", ...body }), headers,
      }, options);
      const text = await r.text();
      assert.equal(r.status, 200, text);
      return text;
    },
  };
}

test("segmented is persisted as the fourth preset and leaves image ordering at quota-first", async () => {
  assert.deepEqual(ROTATION_STRATEGIES, ["quotaFirst", "roundRobin", "preferred", "segmented"]);
  const { policy, source } = await readPoolPolicy();
  assert.equal(source, "settings");
  assert.equal(policy.rotation.strategy, "segmented");
  const accounts = [account("A"), account("B"), account("C")];
  const collect = (effectivePolicy) => {
    const credit = new Map();
    return accounts.map(() => selectPoolOrder({ accounts, credit, policy: effectivePolicy })[0].name);
  };
  assert.deepEqual(collect(policy), collect(DEFAULT_POOL_POLICY));
});

test("identity prefers explicit conversation or thread, uses the SDK cache key, and rejects unstable IDs", () => {
  const explicit = textConversationKey({ conversation: { id: "synthetic-conversation" }, prompt_cache_key: "first" });
  assert.match(explicit, /^[0-9a-f]{64}$/);
  assert.equal(explicit, textConversationKey({ prompt_cache_key: "different" }, { "X-Conversation-Id": "synthetic-conversation" }));
  assert.equal(textConversationKey({ thread_id: "synthetic-thread", prompt_cache_key: "first" }),
    textConversationKey({ prompt_cache_key: "different" }, { "Thread-Id": "synthetic-thread" }));
  assert.equal(textConversationKey({ prompt_cache_key: "cache", session_id: "broad" }), textConversationKey({ prompt_cache_key: "cache" }));
  assert.notEqual(textConversationKey({ thread_id: "cache" }), textConversationKey({ prompt_cache_key: "cache" }));
  assert.equal(textConversationKey({ previous_response_id: "last", input: "don't derive from text", user: "account-wide" }, { "X-Request-Id": "request" }), "");
  assert.equal(textConversationKey({ thread_id: " ", prompt_cache_key: "x".repeat(257) }), "");
});

test("Codex rotates A×3, B×3, C×3, isolates conversations, and preserves upstream cache headers", async () => {
  const f = fixture();
  const base = f.options.fetcher;
  f.options.fetcher = async (url, init) => {
    assert.ok(init.headers.get("thread-id"));
    assert.equal(init.headers.get("session-id"), init.headers.get("thread-id"));
    return base(url, init);
  };
  const actual = [];
  for (let i = 0; i < 10; i++) {
    actual.push(await f.turn({ prompt_cache_key: "primary" }));
    if (i === 4) assert.equal(await f.turn({ prompt_cache_key: "other" }), "B");
  }
  assert.deepEqual(actual, ["A", "A", "A", "B", "B", "B", "C", "C", "C", "A"]);
});

test("without a stable key requests rotate equally and do not consume a keyed turn", async () => {
  const f = fixture();
  const keyed = { thread_id: "stable" };
  assert.equal(await f.turn(keyed), "A");
  const actual = [];
  for (let i = 0; i < 6; i++) actual.push(await f.turn({ previous_response_id: "rotating-" + i }));
  assert.deepEqual(actual, ["A", "B", "C", "A", "B", "C"]);
  assert.equal(await f.turn(keyed), "A");
  assert.equal(await f.turn(keyed), "A");
  assert.equal(await f.turn(keyed), "B");
});

test("same-account reauth retry does not change the segment boundary", async () => {
  const f = fixture();
  let reauth = 0;
  const base = f.options.fetcher;
  f.options.fetcher = async (url, init) => {
    if (!f.attempts.length) {
      f.attempts.push(init.headers.get("chatgpt-account-id"));
      return new Response(null, { status: 401 });
    }
    return base(url, init);
  };
  f.options.reauthenticate = async (a) => { reauth++; return a; };
  const actual = [];
  for (let i = 0; i < 4; i++) actual.push(await f.turn({ session_id: "stable" }));
  assert.deepEqual(actual, ["A", "A", "A", "B"]);
  assert.deepEqual(f.attempts, ["A", "A", "A", "A", "B"]);
  assert.equal(reauth, 1);
});

test("429 rebases to the successful substitute; 403 authorization can fail over", async () => {
  const f = fixture();
  const base = f.options.fetcher;
  f.options.fetcher = async (url, init) => {
    const name = init.headers.get("chatgpt-account-id");
    if (name === "A" && f.attempts.length === 1) {
      f.attempts.push(name);
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    }
    return base(url, init);
  };
  const actual = [];
  for (let i = 0; i < 5; i++) actual.push(await f.turn({ prompt_cache_key: "stable" }));
  assert.deepEqual(actual, ["A", "B", "B", "B", "C"]);
  assert.deepEqual(f.attempts, ["A", "A", "B", "B", "B", "C"]);
  assert.equal(await f.turn({ prompt_cache_key: "new-conversation" }), "B");

  const g = fixture();
  const healthy = g.options.fetcher;
  g.options.fetcher = async (url, init) => {
    const name = init.headers.get("chatgpt-account-id");
    if (name !== "A") return healthy(url, init);
    g.attempts.push(name);
    return new Response(null, { status: 403 });
  };
  assert.equal(await g.turn({ prompt_cache_key: "denied" }), "B");
  assert.equal(await g.turn({ prompt_cache_key: "denied" }), "B");
  assert.deepEqual(g.attempts, ["A", "B", "B"]);
});

test("expired credentials and ledger cooldowns do not receive a segment ahead of healthy accounts", async () => {
  const f = fixture([account("A", { expired: true }), account("B"), account("C")]);
  await recordTextCall({ email: "B@example.invalid", rateLimited: true }, { statsStore: f.options.statsStore });
  assert.equal(await f.turn({ prompt_cache_key: "stable" }), "C");
  assert.deepEqual(f.attempts, ["C"]);
});

test("Web rotation uses the same boundaries, retry semantics, and 429 rebasing", async () => {
  const accounts = ["W1", "W2", "W3"].map((name) => account(name, { web: true }));
  const f = fixture(accounts);
  const base = f.options.webTextRunner;
  const tried = new Map();
  f.options.webTextRunner = async (payload) => {
    const name = accounts.find((a) => a.accessToken === payload.access_token).name;
    const count = (tried.get(name) || 0) + 1;
    tried.set(name, count);
    if (name === "W1" && count < 3) {
      f.attempts.push(name);
      return count === 1
        ? { ok: false, http_status: 401, token_invalid: true, error: "synthetic 401" }
        : { ok: false, http_status: 429, retry_after: 120, error: "synthetic 429" };
    }
    return base(payload);
  };
  f.options.reauthenticate = async (a) => a;
  const body = { prompt_cache_key: "web-thread", stream: true };
  for (const name of ["W2", "W2", "W2", "W3", "W3", "W3", "W2"]) {
    assert.match(await f.turn(body), new RegExp('"text":"' + name + '"'));
  }
  assert.deepEqual(f.attempts, ["W1", "W1", "W2", "W2", "W2", "W3", "W3", "W3", "W2"]);
});

test("mixed pools rotate across transports only when Web can represent the request", async () => {
  const f = fixture([account("A"), account("B-web", { web: true }), account("C")]);
  for (let i = 0; i < 7; i++) await f.turn({ prompt_cache_key: "plain" });
  assert.deepEqual(f.attempts, ["A", "A", "A", "B-web", "B-web", "B-web", "C"]);
  f.attempts.length = 0;
  for (let i = 0; i < 4; i++) {
    await f.turn({ prompt_cache_key: "tools", tools: [{ type: "function", name: "synthetic" }] });
  }
  assert.deepEqual(f.attempts, ["C", "C", "C", "A"]);
});

test("reservation state has idle TTL and LRU and ignores out-of-order responses", () => {
  let now = 0;
  const accounts = [account("A"), account("B"), account("C")];
  const r = createSegmentedTextRotation({ now: () => now, ttlMs: 10, maxEntries: 2 });
  const reserve = (key) => r.reserve(key, accounts, accounts);
  const chosen = (key) => reserve(key).ordered[0].name;
  const stale = reserve("first");
  assert.equal(chosen("other"), "B");
  assert.equal(chosen("first"), "A");
  assert.equal(chosen("new"), "C");
  stale.onSuccess(accounts[2]);
  assert.equal(chosen("first"), "A");
  assert.equal(chosen("first"), "B");
  assert.equal(chosen("other"), "A");
  assert.equal(chosen("other"), "A");
  assert.equal(chosen("other"), "A");
  now += 10;
  assert.equal(chosen("other"), "B");
});
