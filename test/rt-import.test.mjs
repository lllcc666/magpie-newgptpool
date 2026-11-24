import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAccounts } from "../lib/credentials.mjs";
import { runBatch } from "../lib/importer.mjs";
import { listPool, upsertPool } from "../lib/pool-vault.mjs";
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL, refreshCodexToken } from "../lib/web-oauth.mjs";

const original = "rt_mock_original_01";
const rotated = "rt_mock_rotated_02";
const email = "preview-hush@example.test";
const accountId = "acct_mock_import";
const jwt = (claims) => [
  Buffer.from('{"alg":"RS256"}').toString("base64url"),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString("base64url"),
  "mock_signature",
].join(".");
const forbid = () => assert.fail("unexpected side effect");
const refreshMock = (reply) => (options) => refreshCodexToken({
  ...options,
  fetcher: async (url, init) => {
    assert.equal(url, CODEX_TOKEN_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body.client_id, CODEX_CLIENT_ID);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, original);
    return new Response(JSON.stringify(reply));
  },
});

test("RT text accepts bare, dashed, tab, pipe, comma and space rows, and preserves legacy kinds", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const access = jwt({ email });
  const text = [
    "# format fixtures",
    "refresh_token",
    "rt_mock_bare----abcde",
    "u1@example.test----rt_mock_text1---foo",
    "u2@example.test\tOpaque_mock_text2-9",
    "u3@example.test | rt_mock_text3----bar",
    "u4@example.test,rt_mock_text4abcdef",
    "u5@example.test rt_mock_text5abcdef",
    "u6@example.test----Legacy_long_password_06",
    "u7@example.test--pw--" + seed + "--" + access,
    access,
  ].join("\r\n");
  const result = parseAccounts(text);
  assert.deepEqual(result.accounts.map((a) => a.kind), [
    ...Array(6).fill("refresh_token"), "standard", "access_token",
  ]);
  assert.equal(result.accounts[1].refreshToken, "rt_mock_text1---foo");
  assert.equal(result.accounts[0].email, "");
  assert.equal(result.errors.length, 1);
  assert(!JSON.stringify(result.errors).includes(access));
});

test("versioned RTs work in pasted fourth-column, two-column and bare formats", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const token = "rt.1.synthetic----contains--dashes";
  const address = "import+tag@example.test";
  const four = [address, "demo-password", seed, token].join("----");
  for (const source of [four, [address, "demo-password", seed, token].join("--"), address + "----" + token, token]) {
    const parsed = parseAccounts(source);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.accounts[0].kind, "refresh_token");
    assert.equal(parsed.accounts[0].refreshToken, token);
    assert.equal(parsed.accounts[0].email, source === token ? "" : address);
  }
  const legacy = parseAccounts(address + "----Legacy_long_password_01");
  assert.equal(legacy.accounts[0].kind, "standard");
  for (const source of [four + "。", [address, "pw", seed, "rt.123456789012345."].join("----")]) {
    const invalid = parseAccounts(source);
    assert.equal(invalid.accounts.length, 0);
    assert.match(invalid.errors[0].reason, /Refresh Token 格式不正确/);
    assert(!JSON.stringify(invalid.errors).includes(token));
  }
});

test("four-column RT import uses only OAuth and does not store the accompanying password or TOTP", async () => {
  const password = "mock-four-column-password";
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const refreshToken = "rt.1.synthetic_four_column";
  const source = [email, password, seed, refreshToken].join("----");
  const records = [], events = [];
  const args = {
    file: "mock-four-column.txt", consent: true, read: async () => source,
    login: forbid, verifyToken: forbid, checkQuota: null,
    refresh: async (opts) => {
      assert.equal(opts.refreshToken, refreshToken);
      return { accessToken: jwt({ email }), refreshToken: rotated };
    },
    savePool: async (record) => records.push(record),
    onProgress: (event) => events.push(event),
  };
  const preview = await runBatch({ ...args, dryRun: true, refresh: forbid, savePool: forbid, onProgress: forbid });
  assert.equal(preview.ready[0].kind, "refresh_token");
  const result = await runBatch(args);
  assert.equal(result.added, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].refreshToken, rotated);
  assert.equal(records[0].password, "");
  assert.equal(records[0].totp, "");
  for (const value of [password, seed, refreshToken, rotated, email]) {
    assert(!JSON.stringify({ preview, result, events }).includes(value));
  }
});

test("reference JSON containers and JSONL accept RT but never trust imported AT, ID token or proxy", () => {
  const txt = JSON.stringify({ accounts: [
    { platform: "openai", type: "oauth", credentials: { email, chatgpt_account_id: accountId, refresh_token: original, access_token: "ignored_value" } },
    { type: "codex", tokens: { refresh_token: rotated, id_token: "ignored_value" } },
    { type: "apikey", credentials: { refresh_token: "rt_not_oauth_mock" } },
  ], proxies: ["https://unsafe.example.test"] });
  const parsed = parseAccounts(txt);
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.accounts[0].expectedAccountId, accountId);
  assert.equal(parsed.accounts[1].email, "");
  assert(!JSON.stringify(parsed).includes("ignored_value"));
  assert(!JSON.stringify(parsed).includes("unsafe.example.test"));
  const jsonl = '{"refresh_token":"' + original + '"}\n{"refreshToken":"' + rotated + '"}';
  assert.equal(parseAccounts(jsonl).accounts.length, 2);
  assert.equal(parseAccounts(JSON.stringify([original, rotated])).accounts.length, 2);
  const malformed = parseAccounts('{"refresh_token":"' + original + '"');
  assert.deepEqual(malformed, { accounts: [], errors: [{ line: 1, reason: "JSON 语法错误" }], duplicates: 0 });
});

test("duplicate RTs merge constraints; conflicting identities are not importable", () => {
  const text = [original, email + "----" + original].join("\n");
  const same = parseAccounts(text);
  assert.equal(same.duplicates, 1);
  assert.equal(same.accounts.length, 1);
  assert.equal(same.accounts[0].email, email);
  const conflict = parseAccounts(text + "\nother@example.test----" + original + "\n" + original);
  assert.equal(conflict.accounts.length, 0);
  assert.equal(conflict.errors.length, 1);
  assert(!JSON.stringify(conflict).includes(original));
  const suppressedAlias = parseAccounts([email + "----" + rotated, email + "----" + original, original].join("\n"));
  assert.equal(suppressedAlias.accounts.length, 1);
  assert.equal(suppressedAlias.accounts[0].refreshToken, rotated);
  assert.equal(suppressedAlias.duplicates, 2);
  const suppressedConflict = parseAccounts([email + "----" + rotated, email + "----" + original, "other@example.test----" + original].join("\n"));
  assert.equal(suppressedConflict.accounts.length, 1);
  assert.equal(suppressedConflict.accounts[0].refreshToken, rotated);
  assert.equal(suppressedConflict.errors.length, 1);
});

test("dry-run is local and non-consensual mode never exchanges an RT", async () => {
  const args = {
    file: "mock-file.json", read: async () => JSON.stringify({ email, refresh_token: original }),
    login: forbid, refresh: forbid, verifyToken: forbid, savePool: forbid, checkQuota: forbid, onProgress: forbid,
  };
  const result = await runBatch({ ...args, dryRun: true });
  assert.equal(result.total, 1);
  assert.equal(result.ready[0].kind, "refresh_token");
  assert(!JSON.stringify(result).includes(original));
  assert(!JSON.stringify(result).includes(email));
  await assert.rejects(runBatch(args), /授权/);
});

test("official mocked exchange derives email and persists a rotated RT before checking access", async () => {
  const root = await mkdtemp(join(tmpdir(), "magpie-rt-import-"));
  try {
    const access = jwt({ "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
    const calls = [], events = [];
    const result = await runBatch({
      file: "mock-rt.txt", consent: true, read: async () => original, login: forbid,
      refresh: refreshMock({ access_token: access, refresh_token: rotated }),
      verifyToken: async (value, opts) => { assert.equal(value, access); assert.equal(opts.expectedEmail, email); calls.push("verify"); return { accepted: true }; },
      savePool: async (record, { batchId }) => { calls.push("save"); return upsertPool(record, { root, batchId }); },
      batchFile: join(root, "batches.json"), checkQuota: null,
      onProgress: (event) => events.push(event),
    });
    assert.equal(result.added, 1);
    assert.equal(result.formats.refresh_token, 1);
    assert.deepEqual(calls, ["save", "verify"]);
    assert.deepEqual(events.map((e) => e.state), ["authorizing", "added"]);
    const [stored] = await listPool({ root });
    assert.equal(stored.email, email);
    assert.equal(stored.refreshToken, rotated);
    assert.equal(stored.password, "");
    assert.equal(stored.totp, "");
    assert.equal(stored.batchId, result.batchId);
    const publicData = JSON.stringify({ result, events });
    for (const value of [original, rotated, email, access]) assert(!publicData.includes(value));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("omitted rotated RT preserves the original; failed health probes are nonblocking", { timeout: 1000 }, async () => {
  const saved = [];
  let markProbeStarted, failProbe;
  const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
  const result = await runBatch({
    file: "mock-rt.txt", consent: true, read: async () => email + "----" + original,
    login: forbid, checkQuota: null, refresh: refreshMock({ access_token: jwt({ email }) }),
    savePool: async (record) => saved.push(record),
    verifyToken: () => new Promise((resolve, reject) => { failProbe = reject; markProbeStarted(); }),
  });
  await probeStarted;
  failProbe(new Error(rotated));
  assert.equal(result.added, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(saved[0].refreshToken, original);
  assert(!JSON.stringify(result).includes(rotated));
});

test("canceling while an RT refresh is in flight completes that rotation but stops the next row", async () => {
  const controller = new AbortController();
  const saved = [];
  let refreshes = 0;
  await assert.rejects(runBatch({
    file: "mock-rt.txt", consent: true, read: async () => [original, rotated].join("\n"),
    login: forbid, checkQuota: null, verifyToken: forbid, signal: controller.signal,
    refresh: async (options) => {
      assert.equal(options.signal, undefined);
      refreshes++;
      controller.abort();
      return { accessToken: jwt({ email }), refreshToken: "rt_rotated_after_cancel_03" };
    },
    savePool: async (record) => saved.push(record),
  }), /取消/);
  assert.equal(refreshes, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].refreshToken, "rt_rotated_after_cancel_03");
});

test("missing or conflicting OAuth email/account ID never reaches verify or storage", async () => {
  for (const reply of [
    { access_token: jwt({}) },
    { access_token: jwt({ email: "wrong@example.test" }) },
    { access_token: jwt({ email }), id_token: jwt({ email: "wrong@example.test" }) },
    { access_token: jwt({ email, chatgpt_account_id: "wrong_id" }) },
    { access_token: jwt({ email }) },
    { access_token: jwt({ email, chatgpt_account_id: accountId }), id_token: jwt({ email, chatgpt_account_id: "wrong_id" }) },
  ]) {
    const result = await runBatch({
      file: "mock-file.json", consent: true,
      read: async () => JSON.stringify({ email, account_id: accountId, refresh_token: original, id_token: jwt({ email, chatgpt_account_id: accountId }) }),
      login: forbid, refresh: refreshMock(reply), verifyToken: forbid, savePool: forbid, checkQuota: null,
    });
    assert.equal(result.added, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /身份/);
    assert(!JSON.stringify(result).includes(email));
  }
});

test("OAuth and legacy failures never echo remote text; invalid_grant remains a known status", async () => {
  const leak = email + " DSH HTTP access_token=" + rotated;
  await assert.rejects(refreshCodexToken({
    refreshToken: original,
    fetcher: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: leak }), { status: 400 }),
  }), (err) => err.status === 400 && err.oauthError === "invalid_grant" && !err.message.includes(leak));
  await assert.rejects(refreshCodexToken({
    refreshToken: original, fetcher: async () => { throw new Error(leak); },
  }), (err) => !err.message.includes(leak));
  for (const text of [original, email + "----mock_password"]) {
    const events = [];
    const fail = async () => { throw new Error(leak); };
    const result = await runBatch({
      file: "mock-file.txt", consent: true, read: async () => text, refresh: fail, login: fail,
      savePool: forbid, verifyToken: forbid, checkQuota: null, onProgress: (event) => events.push(event),
    });
    assert.equal(result.failed.length, 1);
    assert(!JSON.stringify({ result, events }).includes(rotated));
  }
});
