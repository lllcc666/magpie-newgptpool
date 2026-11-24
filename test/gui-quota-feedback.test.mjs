import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../gui/app.js", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../gui/dashboard.html", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  children = [];
  value = "";
  disabled = false;
  dataset = {};
  style = {};
  listeners = new Map();
  classes = new Set();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  #text = "";
  get textContent() { return this.#text + this.children.map((child) => child.textContent).join(""); }
  set textContent(text) { this.#text = String(text); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.#text = ""; this.children = children; }
  setAttribute() {}
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { if (!this.disabled) return this.listeners.get("click")?.(); }
}

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const account = (n) => ({ id: "slot-" + n, slotLabel: "测试账号 " + n });

function mount({ accounts = [account(1)], text = () => response({ accounts: [], job: null }), refresh, connection }) {
  const elements = new Map(Array.from(dashboard.matchAll(/\bid="([^"]+)"/g), ([, id]) => [id, new Element()]));
  // Use the real dashboard IDs and startup/click handlers; transport and time never leave this VM.
  const node = (id) => elements.get(id);
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  runInNewContext(app, {
    document: {
      getElementById: node,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location: { hash: "" },
    Date: Clock,
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval() {},
    async fetch(url, options) {
      if (url === "api/stats") return response({ accounts });
      if (url === "api/status") return response({ state: "idle" });
      if (url === "api/draft" || url === "api/images?limit=1") return response({});
      if (url === "api/text-quota") return text(options);
      if (url === "api/connection-test" && connection) return connection(options);
      if (url === "api/accounts/refresh" && refresh) return refresh(JSON.parse(options.body));
      return response({ error: "Unexpected local request: " + url }, 500);
    },
  }, { filename: "gui/app.js" });
  const tick = (delay) => {
    const due = [...timers].filter(([, task]) => task.delay <= delay);
    now += delay;
    for (const [id, task] of due) {
      if (timers.delete(id)) task.fn();
    }
  };
  return { node, tick };
}

test("connection button runs on click, reports diagnostics and re-enables", async () => {
  let finish;
  let calls = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { node } = mount({ accounts: [], connection(options) {
    assert.equal(options.method, "POST");
    assert.equal(options.body, "{}");
    calls++;
    return pending;
  } });
  await settle();
  assert.equal(calls, 0);
  const button = node("testConnection");
  const feedback = node("connectionFeedback");
  const check = button.click();
  assert.equal(button.disabled, true);
  assert.match(feedback.textContent, /正在测试/);
  button.click();
  assert.equal(calls, 1);
  finish(response({ mode: "network_only", state: "rate_limited", status: 429, latencyMs: 12 }));
  await check;
  assert.equal(button.disabled, false);
  assert.equal(feedback.classList.contains("is-error"), true);
  assert.match(feedback.textContent, /限流.*HTTP 429.*12 ms/);
});

const job = (state, completed = 0) => ({ id: "synthetic-job", state, completed, total: 2, succeeded: completed });

test("reloading a dashboard restores a completed or failed text-quota job", async () => {
  for (const [state, label] of [["completed", /文本额度查询完成/], ["failed", /查询中断/]]) {
    const { node } = mount({ text: () => response({ accounts: [], job: job(state, 1) }) });
    await settle();
    const feedback = node("textQuotaFeedback");
    assert.match(feedback.textContent, label, state);
    assert.match(feedback.textContent, /已更新 1/);
    assert.equal(feedback.classList.contains("is-error"), state === "failed");
    assert.equal(node("refreshTextQuota").disabled, false);
  }
});

test("a reloaded paused text-quota job retries a progress error and shows completion", async () => {
  const replies = [response({ accounts: [], job: job("paused", 1) }), response({}, 503),
    response({ accounts: [], job: job("completed", 2) })];
  const { node, tick } = mount({ text: () => replies.shift() });
  const feedback = node("textQuotaFeedback");
  await settle();
  assert.match(feedback.textContent, /暂缓 · 1 [/] 2/);
  assert.equal(node("refreshTextQuota").disabled, true);
  tick(2500);
  await settle();
  assert.match(feedback.textContent, /暂时读不到查询进度/);
  assert.equal(feedback.classList.contains("is-error"), true);
  tick(3000);
  await settle();
  assert.match(feedback.textContent, /查询完成 · 已更新 2/);
  assert.equal(feedback.classList.contains("is-error"), false);
  assert.equal(node("refreshTextQuota").disabled, false);
});

test("refreshing the list does not replace or clear ongoing image-quota progress", async () => {
  const accounts = Array.from({ length: 5 }, (_, i) => account(i + 1));
  const requests = [];
  let finishLast;
  const last = new Promise((resolve) => { finishLast = resolve; });
  const quotaResponse = (ids) => response({ quotaChecked: ids.length,
    results: ids.map((id) => ({ id, quotaOk: true, imageQuota: 1 })), quotaStats: { totalQuota: 5 } });
  const { node, tick } = mount({ accounts, async refresh({ ids }) {
    requests.push(ids);
    if (requests.length === 2) await last;
    return quotaResponse(ids);
  } });
  await settle();
  const imageRefresh = node("refreshStatsQuota");
  const listRefresh = node("refreshAccounts");
  const feedback = node("batchStatus");
  const imageTask = imageRefresh.click();
  await settle();
  assert.deepEqual(requests, [["slot-1", "slot-2", "slot-3", "slot-4"], ["slot-5"]]);
  assert.match(feedback.textContent, /生图额度.*4 [/] 5/);
  const listTask = listRefresh.click();
  assert.equal(listRefresh.disabled, true);
  await settle();
  const progressDuring = feedback.textContent;
  tick(420);
  await listTask;
  const progressAfter = feedback.textContent;
  assert.equal(listRefresh.disabled, false);
  assert.equal(imageRefresh.disabled, true);
  finishLast();
  await imageTask;
  assert.match(progressDuring, /生图额度.*4 [/] 5/);
  assert.match(progressAfter, /生图额度.*4 [/] 5/);
  assert.match(node("notice").textContent, /已更新 5 个账号/);
  assert.equal(feedback.textContent, "");
  assert.equal(imageRefresh.disabled, false);
});
