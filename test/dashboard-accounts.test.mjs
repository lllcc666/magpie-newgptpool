import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser, openDashboard, until } from "./dashboard-browser.mjs";

const browser = findBrowser();
const skip = !browser && "Requires a locally installed Chromium/Edge; set GPTPOOL_TEST_BROWSER to the executable path";
const ids = Array.from({ length: 6 }, (_, index) => "fixture-account-" + (index + 1));
const proxy = "http://proxy.fixture.invalid:43210";
const oauthId = "fixture/flow+one";
const oauthUrl = "https://oauth.fixture.invalid/authorize?state=fixture";
const callback = "http://127.0.0.1:1455/auth/callback?code=fixture-only";
const row = (id) => '#statsRows .account-row[data-id="' + id + '"]';
const reply = (body, status = 200) => ({ body, status });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeMock() {
  const accounts = ids.map((id, index) => ({
    id, email: id + "@fixture.invalid", slotLabel: "Fixture Slot " + (index + 1), slotTag: "fixture-slot-" + (index + 1),
    planType: "free", hasAccess: true, tokenState: "valid", imageQuota: 20 - index,
  }));
  const textSnapshot = () => ({ accounts: ids.map((id) => ({ id, status: "available",
    shortWindow: { windowMinutes: 300, usedPercent: 25, status: "available" } })), job: null });
  const handlers = new Map();
  function results(targets, quotaOnly) {
    const results = targets.map((id) => {
      const account = accounts.find((item) => item.id === id);
      assert.ok(account, "Only fixture account IDs are accepted");
      return { id, status: quotaOnly ? "checked" : "valid", quotaOk: true, imageQuota: ++account.imageQuota };
    });
    return reply({ results, valid: quotaOnly ? 0 : results.length, quotaChecked: results.length });
  }
  return {
    handlers, accounts, results, textSnapshot,
    handle(call) {
      const { method, path } = call;
      const key = method + " " + path;
      if (handlers.has(key)) return handlers.get(key)(call);
      switch (key) {
        case "GET stats": return reply({ accounts });
        case "GET status": return reply({ state: "idle" });
        case "GET draft": return reply({ hasDraft: false });
        case "GET images": return reply({ allCount: 0 });
        case "GET policy": return reply({ preset: "", presets: [] });
        case "GET text-quota": return reply(textSnapshot());
        case "POST accounts/refresh": return results(call.body.ids, call.body.quotaOnly);
        default: assert.fail("Unexpected fixture API: " + key);
      }
    },
  };
}

async function setup(t) {
  const mock = makeMock();
  const { evaluate, calls, problems } = await openDashboard(t, browser, mock.handle);
  const button = (selector, label, click = false) => evaluate((selector, label, click) => {
    const node = [...document.querySelectorAll(selector)].find((node) =>
      node.getClientRects().length && !node.disabled && (!label || node.textContent.trim() === label));
    if (click) node?.click();
    return Boolean(node);
  }, selector, label, click);
  const click = (selector, label) => until(() => button(selector, label, true), "clickable " + (label || selector));
  const fill = (selector, value) => evaluate((selector, value) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
  const text = (selector) => evaluate((selector) => document.querySelector(selector)?.textContent.trim(), selector);
  const value = (selector) => evaluate((selector) => document.querySelector(selector)?.value, selector);
  const visible = (selector) => evaluate((selector) => Boolean(document.querySelector(selector)?.getClientRects().length), selector);
  const count = () => evaluate(() => document.querySelectorAll("#statsRows .account-row").length);
  const posts = (path) => calls.filter((call) => call.method === "POST" && (!path || call.path === path));
  const waitText = (selector, expected) => until(async () => expected.test(await text(selector)), selector + " containing " + expected);
  t.after(() => assert.deepEqual(problems, [], "No unexpected API requests, page exceptions, or outbound browser URLs"));
  await until(async () => await count() === ids.length, "fixture account rows");
  await waitText(row(ids[0]) + " .text-quota-content", /75%/);
  return { mock, evaluate, calls, button, click, fill, text, value, visible, count, posts, waitText };
}

async function setProxy(h) {
  await h.click("#goAccountConnection");
  await h.fill("#poolProxyInput", proxy);
  await h.click('[data-tab="stats"]');
}

test("account and import shortcuts share one session proxy; connection test is manual", { skip, timeout: 25_000 }, async (t) => {
  const h = await setup(t);
  assert.equal(await h.visible("#poolProxyInput"), false);
  assert.deepEqual(h.posts(), []);
  await h.click("#goAccountConnection");
  assert.equal(await h.visible("#settingsPanel"), true);
  assert.equal(await h.evaluate(() => document.querySelectorAll('#settingsPanel #poolProxyInput').length), 1);
  assert.equal(await h.evaluate(() => document.querySelectorAll('input[id*="proxy" i]').length), 1);
  await h.fill("#poolProxyInput", proxy);
  await h.click("#goImport");
  assert.equal(await h.visible("#importPanel"), true);
  assert.equal(await h.visible("#poolProxyInput"), false);
  await h.click("#goImportConnection");
  assert.equal(await h.visible("#settingsPanel"), true);
  assert.equal(await h.value("#poolProxyInput"), proxy);
  assert.deepEqual(await h.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await h.click('[data-tab="stats"]');
  const pending = deferred();
  h.mock.handlers.set("POST connection-test", () => pending.promise);
  assert.deepEqual(h.posts(), [], "Navigation and proxy editing do not send writes");
  await h.click("#testConnection");
  await until(() => h.posts().length === 1, "manual connection request");
  assert.deepEqual(h.posts()[0], { method: "POST", path: "connection-test", query: {}, body: {} });
  assert.equal(await h.button("#testConnection"), false);
  await h.waitText("#connectionFeedback", /正在测试/);
  pending.resolve(reply({ mode: "network_only", state: "rate_limited", status: 429, latencyMs: 12 }));
  await h.waitText("#connectionFeedback", /限流.*429.*12 ms/);
  assert.equal(await h.button("#testConnection"), true);
});

test("image and authorization controls use exact scopes and keep progress through a local reload", { skip, timeout: 40_000 }, async (t) => {
  const h = await setup(t);
  await setProxy(h);
  const [first, second, third] = ids;
  for (const selector of ["#poolBatchCheck", "#poolBatchRenew"]) {
    assert.equal(await h.evaluate((selector) => document.querySelector(selector).disabled, selector), true);
  }
  await h.click(row(second) + " input[type=checkbox]");
  await h.click(row(third) + " input[type=checkbox]");
  await h.waitText("#poolBatchCount", /已选 2 个/);
  await h.fill("#poolSearch", "fixture-slot-6");
  await until(async () => await h.count() === 1, "only an unselected account is visible");

  function assertRefresh(start, targets, quotaOnly) {
    const requests = h.posts().slice(start);
    for (const { method, path, query, body } of requests) {
      assert.equal(method, "POST");
      assert.equal(path, "accounts/refresh");
      assert.deepEqual(query, {});
      assert.deepEqual(body, { ids: body.ids, quotaOnly, proxy });
      assert.ok(body.ids.length > 0 && body.ids.length <= 4);
    }
    assert.deepEqual(requests.flatMap(({ body }) => body.ids).sort(), [...targets].sort());
  }
  async function check(selector, label, targets, quotaOnly) {
    const start = h.posts().length;
    await h.click(selector, label);
    await h.waitText("#batchStatus", /^$/);
    await until(async () => h.posts().length > start && await h.button(selector, label), label + " finishes");
    assertRefresh(start, targets, quotaOnly);
  }
  const hold = deferred();
  h.mock.handlers.set("POST accounts/refresh", ({ body }) => body.ids.includes(ids.at(-1))
    ? hold.promise.then(() => h.mock.results(body.ids, body.quotaOnly)) : h.mock.results(body.ids, body.quotaOnly));
  const start = h.posts().length;
  await h.click("#refreshStatsQuota", "刷新全部生图");
  try {
    await until(() => h.posts().length === start + 2, "second image quota chunk blocked in fixture");
    await h.waitText("#batchStatus", /4 [/] 6/);
    h.mock.accounts.at(-1).slotLabel = "Locally Reloaded Fixture Slot";
    await h.click("#refreshAccounts");
    await h.waitText(row(ids.at(-1)) + " .acct-name", /Locally Reloaded Fixture Slot/);
    assert.match(await h.text("#batchStatus"), /4 [/] 6/);
    assert.equal(await h.button("#refreshAllPool"), false);
    assert.equal(h.posts().length, start + 2, "Local reload adds no write requests");
  } finally { hold.resolve(); }
  await until(() => h.button("#refreshStatsQuota", "刷新全部生图"), "image refresh re-enabled");
  assertRefresh(start, ids, true);
  h.mock.handlers.delete("POST accounts/refresh");

  await check("#refreshAllPool", "检查全部授权", ids, false);
  await h.fill("#poolSearch", "");
  await until(async () => await h.count() === ids.length, "account search cleared");
  await check("#poolBatchCheck", "刷新所选生图", [second, third], true);
  await check("#poolBatchRenew", "检查所选授权", [second, third], false);
  // Observe the table replacing its row controls while the minimum busy indicator is still showing.
  await h.evaluate((rowSelector) => {
    const busyHost = document.querySelector("#batchStatus");
    const table = document.querySelector("#statsRows");
    const observer = new MutationObserver(() => {
      const auth = [...document.querySelectorAll(rowSelector + " button")]
        .find((node) => node.textContent.trim() === "检查授权");
      if (busyHost.textContent.trim() && auth && !auth.disabled) window.rowActionEnabledWhileBusy = true;
    });
    observer.observe(table, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    observer.observe(busyHost, { childList: true, subtree: true });
  }, row(first));
  await check(row(first) + " button", "刷新生图", [first], true);
  assert.equal(await h.evaluate(() => Boolean(window.rowActionEnabledWhileBusy)), false,
    "A rebuilt row must not advertise an available authorization action while image refresh is still busy");
  await check(row(first) + " button", "检查授权", [first], false);
});

test("text quota uses its own job and single-account request without renewal or proxy", { skip, timeout: 25_000 }, async (t) => {
  const h = await setup(t);
  await setProxy(h);
  const [first] = ids;
  const job = { id: "fixture-text-job", state: "running", completed: 1, total: ids.length, succeeded: 1 };
  h.mock.handlers.set("POST text-quota", ({ body }) => body.id
    ? reply(h.mock.textSnapshot()) : reply({ ...h.mock.textSnapshot(), job }, 202));
  await h.click("#refreshTextQuota", "刷新全部文本");
  await h.waitText("#textQuotaFeedback", /1 [/] 6/);
  assert.equal(await h.button("#refreshTextQuota"), false);
  assert.equal(await h.button(row(first) + " button", "刷新文本"), false);
  assert.deepEqual(h.posts().map(({ path, body }) => [path, body]), [["text-quota", {}]]);
  h.mock.handlers.set("GET text-quota", () => reply({ ...h.mock.textSnapshot(),
    job: { ...job, state: "completed", completed: ids.length, succeeded: ids.length } }));
  await h.waitText("#textQuotaFeedback", /查询完成.*已更新 6/);
  await h.click(row(first) + " button", "刷新文本");
  await h.waitText("#textQuotaFeedback", /Fixture Slot 1.*文本额度：可用/);
  assert.deepEqual(h.posts().map(({ path, body }) => [path, body]), [["text-quota", {}], ["text-quota", { id: first }]]);
});

test("mock OAuth uses the flow ID and keeps the panel open when cancellation fails", { skip, timeout: 25_000 }, async (t) => {
  const h = await setup(t);
  await setProxy(h);
  const poll = deferred();
  const cancel = deferred();
  let cancels = 0;
  h.mock.handlers.set("POST oauth/start", () => reply({ id: oauthId, url: oauthUrl, state: "waiting" }));
  h.mock.handlers.set("GET oauth/status", ({ query }) => {
    assert.deepEqual(query, { id: oauthId });
    return poll.promise;
  });
  h.mock.handlers.set("POST oauth/open", () => reply({ opened: true }));
  h.mock.handlers.set("POST oauth/callback", () => reply({ state: "waiting", error: "fixture callback rejected" }));
  h.mock.handlers.set("POST oauth/cancel", () => ++cancels === 1 ? cancel.promise : reply({ id: oauthId, state: "canceled" }));
  await h.click("#goImport");
  assert.equal(await h.visible("#oauthPanel"), false);
  await h.click("#oauthLogin");
  await until(async () => await h.value("#oauthUrl") === oauthUrl, "fixture authorization URL");
  await h.click("#oauthOpen");
  await until(() => h.posts("oauth/open").length === 1, "mock open request");
  await until(() => h.calls.some(({ path }) => path === "oauth/status"), "fixture OAuth poll in flight");
  await h.click("#oauthCancel");
  try {
    await until(() => cancels === 1, "first cancellation in flight");
    assert.equal(await h.button("#oauthOpen"), false);
    assert.equal(await h.button("#oauthCancel"), false);
    poll.resolve(reply({ id: oauthId, state: "done", accountLabel: "stale fixture result" }));
    cancel.resolve(reply({ error: "fixture cancel failed" }, 503));
    await h.waitText("#oauthState", /fixture cancel failed/);
    assert.equal(await h.visible("#oauthPanel"), true);
    assert.equal(await h.value("#oauthUrl"), oauthUrl);
  } finally {
    poll.resolve(reply({ id: oauthId, state: "waiting" }));
    cancel.resolve(reply({ error: "fixture cancel failed" }, 503));
  }
  h.mock.handlers.set("GET oauth/status", () => reply({ id: oauthId, state: "waiting" }));
  await h.fill("#oauthCallback", callback);
  await h.click("#oauthSubmit");
  await h.waitText("#oauthState", /fixture callback rejected/);
  await h.click("#oauthCancel");
  await until(async () => !await h.visible("#oauthPanel"), "panel closes after successful cancellation");
  assert.deepEqual(h.posts().map(({ path, body }) => [path, body]), [
    ["oauth/start", { open: true, proxy }], ["oauth/open", { id: oauthId }],
    ["oauth/cancel", { id: oauthId }], ["oauth/callback", { id: oauthId, callback }], ["oauth/cancel", { id: oauthId }],
  ]);
});
