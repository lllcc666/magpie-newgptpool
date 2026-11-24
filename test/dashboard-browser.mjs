import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function findBrowser() {
  if (process.env.GPTPOOL_TEST_BROWSER) return process.env.GPTPOOL_TEST_BROWSER;
  const candidates = process.platform === "win32"
    ? [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
      .filter(Boolean).flatMap((root) => [join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(root, "Google", "Chrome", "Application", "chrome.exe")])
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return candidates.find(existsSync);
}

export async function until(predicate, description, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for " + description);
}

function connect(child) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  const pending = new Map();
  const handlers = new Map();
  let nextId = 0;
  let buffer = "";
  let disconnectError;
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-2_000); });
  const disconnect = (error) => {
    disconnectError ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(disconnectError);
    }
    pending.clear();
  };
  child.on("error", disconnect);
  input.on("error", disconnect);
  output.on("error", disconnect);
  child.on("close", (code) => disconnect(new Error("Browser closed (" + code + "): " + diagnostics)));
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    const messages = buffer.split("\0");
    buffer = messages.pop();
    for (const raw of messages) {
      const message = JSON.parse(raw);
      if (!message.id) {
        handlers.get(message.method)?.(message.params, message.sessionId);
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(waiter.method + ": " + message.error.message));
      else waiter.resolve(message.result);
    }
  });
  return {
    on(method, handler) { handlers.set(method, handler); },
    async send(method, params = {}, sessionId) {
      if (disconnectError) throw disconnectError;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timed out talking to browser: " + method + ": " + diagnostics));
        }, 5_000);
        pending.set(id, { method, timer, resolve, reject });
        input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      });
    },
  };
}

// Supply the actual dashboard and every API response through the DevTools pipe.
// There is no HTTP listener, account store, app service, or live OAuth endpoint.
export async function openDashboard(t, executable, mockApi) {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../gui/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../gui/app.js", import.meta.url), "utf8"),
    readFile(new URL("../gui/style.css", import.meta.url), "utf8"),
  ]);
  const origin = "http://dashboard.fixture.invalid";
  const token = "synthetic-dashboard-session";
  const assets = new Map([
    ["/ui", ["text/html", html.replace("__GPTFREE_SESSION__", token).replace("__GPTFREE_ENTRY_MODE__", "sidebar")]],
    ["/assets/app.js", ["text/javascript", app]],
    ["/assets/style.css", ["text/css", css]],
    ["/favicon.ico", ["image/x-icon", ""]],
  ]);
  const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";
  const calls = [];
  const problems = [];
  const profile = await mkdtemp(join(tmpdir(), "gptpool-dashboard-"));
  const child = spawn(executable, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-quic",
    "--disable-features=OptimizationHints,AutofillServerCommunication,MediaRouter,DnsOverHttps",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND",
    "--remote-debugging-pipe", "--user-data-dir=" + profile,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const cdp = connect(child);
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), delay(500, undefined, { ref: false })]);
      await Promise.race([closed, delay(1_000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const { product } = await cdp.send("Browser.getVersion");
  t.diagnostic("Isolated headless browser: " + product);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  async function fulfill(requestId, responseCode, type, body) {
    await send("Fetch.fulfillRequest", {
      requestId, responseCode, body: Buffer.from(body).toString("base64"),
      responseHeaders: [
        { name: "Content-Type", value: type + "; charset=utf-8" },
        { name: "Content-Security-Policy", value: csp },
        { name: "Cache-Control", value: "no-store" },
      ],
    });
  }
  async function handleRequest({ request, requestId }) {
    const url = new URL(request.url);
    if (url.origin !== origin) {
      problems.push("Blocked nonfixture browser URL: " + url.href);
      await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      return;
    }
    const asset = request.method === "GET" && assets.get(url.pathname);
    if (asset) return fulfill(requestId, 200, ...asset);
    try {
      assert.ok(url.pathname.startsWith("/api/"), "Unexpected fixture path: " + url.pathname);
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(headers["x-gptfree-session"], token);
      const call = { method: request.method, path: url.pathname.slice(5), query: Object.fromEntries(url.searchParams),
        body: request.postData === undefined ? undefined : JSON.parse(request.postData) };
      calls.push(call);
      const { status = 200, body } = await mockApi(call);
      await fulfill(requestId, status, "application/json", JSON.stringify(body));
    } catch (error) {
      problems.push(error.stack || String(error));
      await fulfill(requestId, 500, "application/json", JSON.stringify({ error: "Unexpected fixture request" }));
    }
  }
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }, id) => {
    if (id === sessionId) problems.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  cdp.on("Fetch.requestPaused", (params, id) => {
    if (id === sessionId) void handleRequest(params).catch((error) => problems.push(error.message));
  });
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const navigation = await send("Page.navigate", { url: origin + "/ui" });
  assert.equal(navigation.errorText, undefined);

  async function evaluate(fn, ...args) {
    const result = await send("Runtime.evaluate", {
      expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  return { evaluate, calls, problems };
}
