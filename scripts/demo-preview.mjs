#!/usr/bin/env node
// 本地假数据预览：独立进程、临时 vault 和图片目录，不调用任何上游。
//   node scripts/demo-preview.mjs                              # 回环临时端口，Ctrl+C 退出
//   node scripts/demo-preview.mjs --screenshot                 # Edge 1250×845 桌面截图
//   node scripts/demo-preview.mjs --screenshot --mobile        # 另存 Edge 390×844 设备模拟截图
//   node scripts/demo-preview.mjs --mobile-only --overwrite    # 仅更新本脚本的手机图
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, copyFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const mobileOnly = args.includes("--mobile-only");
const screenshot = args.includes("--screenshot") || mobileOnly;
const mobile = args.includes("--mobile") || mobileOnly;
const overwrite = args.includes("--overwrite");
const usage = "node scripts/demo-preview.mjs [--screenshot [--mobile] | --mobile-only] [--overwrite]";
if (args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
if (args.some((arg) => !["--screenshot", "--mobile", "--mobile-only", "--overwrite"].includes(arg)) ||
    (!screenshot && (mobile || overwrite)) || (mobileOnly && (args.includes("--screenshot") || args.includes("--mobile")))) {
  throw new Error("用法: " + usage);
}

const exec = promisify(execFile);
const uiFetch = globalThis.fetch;
const disabled = async () => { throw new Error("演示号池已禁用外部请求和账号操作"); };
// 本进程只使用下面显式限定的回环客户端；模块初始化时也不能获取真实 fetch。
globalThis.fetch = disabled;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (n) => iso(now - n * 86400000);

// 结构完整、签名是假的 JWT：只为让本地解码出 exp，不会发给任何上游。
function fakeToken(expMs, id, web) {
  return [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({
      exp: Math.floor(expMs / 1000),
      ...(web ? { "https://api.openai.com/profile": {} } : { chatgpt_account_id: id }),
    })).toString("base64url"),
    "demo-signature",
  ].join(".");
}
const fixtures = [
  { email: "alpha@demo.test", quota: 18, plan: "plus", success: 42, fail: 1 },
  { email: "bravo@demo.test", quota: 25, plan: "plus", success: 31, fail: 0 },
  { email: "charlie@demo.test", quota: 12, plan: "free", success: 27, fail: 2 },
  { email: "delta@demo.test", quota: 31, plan: "plus", success: 18, fail: 0 },
  { email: "echo@demo.test", quota: 9, plan: "free", success: 14, fail: 3 },
  { email: "foxtrot@demo.test", quota: 6, plan: "free", success: 9, fail: 1 },
  { email: "golf@demo.test", quota: 14, plan: "plus", success: 7, fail: 0 },
  { email: "hotel@demo.test", quota: 22, plan: "plus", success: 5, fail: 0 },
  { email: "india@demo.test", quota: 0, plan: "free", success: 11, fail: 4, limited: true },
  { email: "juliett@demo.test", quota: 0, plan: "free", success: 3, fail: 2, limited: true },
  { email: "kilo@demo.test", web: true, quota: null, plan: null, success: 0, fail: 0 },
  { email: "lima@demo.test", quota: null, plan: null, success: 0, fail: 0 },
  { email: "mike@demo.test", quota: null, plan: "plus", success: 0, fail: 0, quotaError: "查询 ChatGPT Web 生图额度失败：connect ETIMEDOUT" },
  { email: "november@demo.test", quota: 16, plan: "plus", success: 8, fail: 0, expired: true },
  { email: "oscar@demo.test", quota: 0, plan: "free", success: 0, fail: 0, deadAt: daysAgo(2), authFails: 3 },
  { email: "papa@demo.test", quota: 0, plan: "free", success: 0, fail: 15, never: true },
];

const compact = new Set(["alpha", "bravo", "charlie", "delta", "echo", "india", "kilo", "november"]);
const demo = screenshot ? fixtures.filter((a) => compact.has(a.email.split("@")[0])) : fixtures;
const rows = demo.map((a, i) => ({
  email: a.email,
  accessToken: fakeToken(now + (a.expired ? -1 : 1) * 3600_000, a.email.split("@")[0], a.web),
  updatedAt: daysAgo(i % 3),
  line: i + 1,
}));

const quotaByToken = new Map(demo.map((a, i) => ["Bearer " + rows[i].accessToken, {
  available: !a.limited, dead: !!a.deadAt,
  shortUsed: a.limited ? 100 : [22, 8, 64, 41, 17, 77][i % 6],
  longUsed: a.limited ? 83 : [40, 27, 82, 34, 59, 16][i % 6],
  shortReset: 5100 + i * 600,
  longReset: 241200 + i * 1800,
}]));
async function textQuotaFetcher(_url, { headers }) {
  const q = quotaByToken.get(headers.get("authorization"));
  if (!q || q.dead) return Response.json({}, { status: 403 });
  return Response.json({ rate_limit: {
    allowed: q.available,
    limit_reached: !q.available,
    primary_window: { used_percent: q.shortUsed, limit_window_seconds: 18000, reset_after_seconds: q.shortReset },
    secondary_window: { used_percent: q.longUsed, limit_window_seconds: 604800, reset_after_seconds: q.longReset },
  } });
}

function seedStats(createInMemoryStatsStore, accountSlotTag, recordRequest) {
  const statsStore = createInMemoryStatsStore();
  const totals = statsStore.state.totals;
  for (const a of demo) {
    const tag = accountSlotTag(a.email);
    const checkedAt = daysAgo(0);
    const entry = {
      planType: a.plan,
      imageQuota: a.quota,
      quotaCheckedAt: a.quota === null && !a.quotaError ? null : checkedAt,
      quotaError: a.quotaError || null,
      successCalls: a.success,
      failCalls: a.fail,
      textSuccessCalls: Math.round(a.success * 0.7),
      textFailCalls: Math.floor(a.fail / 2),
      lastSuccessAt: a.success ? daysAgo(1) : null,
      lastUsedAt: a.success ? daysAgo(1) : null,
      lastErrorCode: a.fail ? "rate_limited" : null,
      lastErrorAt: a.fail ? daysAgo(1) : null,
      limitedAt: a.limited ? daysAgo(0) : null,
      limitedUntil: a.limited ? iso(now + 3 * 3600_000) : null,
      limitedForMs: a.limited ? 3600_000 : null,
      deadAt: a.deadAt || null,
      authFails: a.authFails || 0,
      failSince: a.never ? daysAgo(5) : null,
    };
    statsStore.state.accounts[tag] = entry;
    totals.successCalls += entry.successCalls;
    totals.failCalls += entry.failCalls;
    totals.textSuccessCalls += entry.textSuccessCalls;
    totals.textFailCalls += entry.textFailCalls;
  }

  // 近 14 天的调用记录：数字有起伏，柱顶才看得出效果。
  const history = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    const success = [18, 24, 31, 12, 0, 9, 27, 34, 41, 22, 16, 38, 44, 29][13 - i];
    const fail = [2, 1, 4, 0, 0, 3, 1, 2, 6, 1, 0, 2, 3, 1][13 - i];
    history[key] = {
      success,
      fail,
      textSuccess: Math.round(success * 0.4),
      textFail: Math.round(fail * 0.3),
      byCode: fail ? { rate_limited: Math.max(1, fail - 1), worker_timeout: 1 } : {},
    };
  }
  statsStore.state.history = history;
  for (let i = 0; i < 24; i++) {
    const ok = i % 9 !== 1;
    const kind = i % 3 ? "image" : "text";
    recordRequest({ kind, ok, email: demo[i % 4].email, status: ok ? 200 : 429,
      code: ok ? "" : "rate_limited", model: kind === "image" ? "gpt-image-2" : "gpt-5.2",
      ms: (kind === "image" ? 7600 : 1400) + i * 71, ttfbMs: 620 + i * 31,
    }, { nowMs: now - (24 - i) * 22000 });
  }
  return statsStore;
}

// ---------- 假图片 ----------
// 图片页要真文件才有缩略图，所以现造几张纯色 PNG（不引任何依赖，手工拼 PNG 分块）。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      // 加点斜向渐变，缩略图排在一起才不糊成一片
      const t = (x + y) / (width + height);
      raw[at] = Math.round(r * (0.65 + t * 0.35));
      raw[at + 1] = Math.round(g * (0.65 + t * 0.35));
      raw[at + 2] = Math.round(b * (0.65 + t * 0.35));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PALETTE = [
  [15, 110, 86], [59, 109, 17], [49, 119, 217], [168, 84, 24],
  [122, 90, 168], [13, 106, 128], [176, 58, 92], [90, 100, 120],
];
async function seedImages(imageDir) {
  await mkdir(imageDir, { recursive: true });
  for (let i = 0; i < 34; i++) {
    const daysBack = Math.min(13, Math.floor(i / 3));
    const mtime = now - daysBack * 86400000 - (i % 7) * 3600_000;
    const name = mtime.toString(36) + "-" + String(i).padStart(16, "0") + ".png";
    const size = 96 + (i % 5) * 32;
    const file = join(imageDir, name);
    await writeFile(file, solidPng(size, size, PALETTE[i % PALETTE.length]));
    await utimes(file, new Date(mtime), new Date(mtime));
  }
}

async function primeTextQuota(origin, signal) {
  const url = new URL("/api/text-quota", origin);
  const page = await uiFetch(new URL("/ui", origin), { redirect: "error", signal });
  if (!page.ok) throw new Error("演示页面 HTTP " + page.status);
  const html = await page.text();
  const session = html.match(/<meta\b(?=[^>]*\bname=['"]gptfree-session['"])(?=[^>]*\bcontent=['"]([a-f0-9]{64})['"])[^>]*>/i)?.[1];
  if (!session) throw new Error("演示页面没有返回会话标识");
  const response = await uiFetch(url, { method: "POST", redirect: "error", signal, headers: {
    Origin: "null", "X-GPTFree-Session": session, "Content-Type": "application/json",
  }, body: "{}" });
  if (!response.ok) throw new Error("演示文本额度 HTTP " + response.status);
  let snapshot = await response.json();
  while (snapshot.job?.state === "running" || snapshot.job?.state === "paused") {
    await delay(150, undefined, { signal });
    const status = await uiFetch(url, { redirect: "error", signal, headers: { "X-GPTFree-Session": session } });
    if (!status.ok) throw new Error("演示文本额度进度 HTTP " + status.status);
    snapshot = await status.json();
  }
  const { accounts, job } = snapshot;
  const states = new Set(accounts?.map((a) => a.status));
  const withBothWindows = accounts?.filter((a) => a.shortWindow && a.longWindow).length;
  if (job?.state !== "completed" || !job.attempted || !states.has("available") ||
      (screenshot && (withBothWindows < 6 || !states.has("limited")))) {
    throw new Error("演示文本额度未生成预期的假状态");
  }
  console.log("演示账号 " + accounts.length + " 个；其中 " + withBothWindows + " 个展示短、长窗口。");
}

const edge = process.env.EDGE_BINARY || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const outputDir = fileURLToPath(new URL("../../", import.meta.url));
const outputStem = "magpie-newgptpool-1.0-magpie-preview";

function edgeArgs(origin, profile) {
  // Use an isolated profile and route all non-preview requests to a blocked proxy.
  return [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync",
    "--disable-quic", "--metrics-recording-only", "--lang=zh-CN",
    "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=<-loopback>;" + new URL(origin).host,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--user-data-dir=" + profile,
  ];
}

async function devtoolsSocket(profile, signal) {
  while (!signal.aborted) {
    try {
      const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("无效的 DevTools 端口");
      const authority = "127.0.0.1:" + port;
      const response = await uiFetch("http://" + authority + "/json/list", { redirect: "error", signal });
      if (!response.ok) throw new Error("Edge DevTools HTTP " + response.status);
      const pages = await response.json();
      const page = pages.find((target) => target.type === "page" && target.url === "about:blank");
      if (page) {
        const url = new URL(page.webSocketDebuggerUrl);
        if (url.protocol !== "ws:" || url.host !== authority || !url.pathname.startsWith("/devtools/page/")) {
          throw new Error("Edge 返回非回环 DevTools 地址");
        }
        return new WebSocket(url);
      }
    } catch (err) {
      if (err.code !== "ENOENT" && !(err instanceof TypeError)) throw err;
    }
    await delay(120, undefined, { signal });
  }
  signal.throwIfAborted();
}

function devtoolsClient(socket, signal) {
  const rejectClosed = (reject) => () => reject(new Error("Edge DevTools 已断开"));
  const once = (attach) => new Promise((resolve, reject) => {
    const closed = rejectClosed(fail);
    const abort = () => fail(signal.reason);
    const done = attach(finish, fail);
    function cleanup() {
      done();
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", closed);
      signal.removeEventListener("abort", abort);
    }
    function finish(result) { cleanup(); resolve(result); }
    function fail(error) { cleanup(); reject(error); }
    socket.addEventListener("close", closed, { once: true });
    socket.addEventListener("error", closed, { once: true });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  let nextId = 0;
  return {
    ready: once((finish) => {
      socket.addEventListener("open", finish, { once: true });
      return () => socket.removeEventListener("open", finish);
    }),
    call(method, params = {}) {
      const id = ++nextId;
      return once((finish, fail) => {
        const onMessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.id !== id) return;
          if (message.error) fail(new Error(method + ": " + message.error.message));
          else finish(message.result);
        };
        socket.send(JSON.stringify({ id, method, params }));
        socket.addEventListener("message", onMessage);
        return () => socket.removeEventListener("message", onMessage);
      });
    },
  };
}

async function captureMobile(origin, profile, output, width, height, signal) {
  if (typeof WebSocket !== "function") throw new Error("手机截图需要支持 WebSocket 的 Node.js（建议 22+）");
  const stopEdge = new AbortController();
  const live = AbortSignal.any([signal, stopEdge.signal, AbortSignal.timeout(30000)]);
  let exited;
  const edgeProcess = exec(edge, [...edgeArgs(origin, profile),
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank",
  ], { windowsHide: true, signal: live }).then(
    () => { exited = new Error("Edge 提前退出"); stopEdge.abort(exited); },
    (err) => { exited = err; stopEdge.abort(err); },
  );
  let socket;
  try {
    socket = await devtoolsSocket(profile, live);
    const cdp = devtoolsClient(socket, live);
    await cdp.ready;
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height,
    });
    const pageUrl = new URL("/ui", origin).href;
    const nav = await cdp.call("Page.navigate", { url: pageUrl });
    if (nav.errorText) throw new Error("Edge 无法打开演示页面: " + nav.errorText);
    const viewportExpression = function (targetUrl) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const read = () => {
          const button = [...document.querySelectorAll('button, [role="button"], a')]
            .find((node) => (node.textContent || "").includes("导入账号") && node.getClientRects().length);
          const ready = location.href === targetUrl && document.body?.innerText.includes("@demo.test");
          if (ready && button) {
            const { x, y, left, top, right, bottom, width, height } = button.getBoundingClientRect();
            resolve({ innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth,
              bodyScrollWidth: document.body.scrollWidth, visualWidth: visualViewport.width,
              importButton: { x, y, left, top, right, bottom, width, height },
            });
          } else if (Date.now() >= deadline) reject(new Error("演示账号或导入账号按钮未完成渲染"));
          else setTimeout(read, 100);
        };
        read();
      });
    };
    // Wait for navigation to finish before evaluating; confirm rendered fake accounts instead of sleeping.
    let measurement;
    for (let i = 0; i < 50; i++) {
      const doc = await cdp.call("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      if (doc.result?.value === pageUrl) {
        measurement = await cdp.call("Runtime.evaluate", {
          expression: "(" + viewportExpression.toString() + ")(" + JSON.stringify(pageUrl) + ")",
          returnByValue: true, awaitPromise: true,
        });
        break;
      }
      await delay(100, undefined, { signal: live });
    }
    const viewport = measurement?.result?.value;
    if (!viewport) throw new Error(measurement?.exceptionDetails?.exception?.description || "无法测量手机视口");
    console.log("Edge 手机视口: " + JSON.stringify(viewport));
    if (Math.abs(viewport.visualWidth - width) >= 1) throw new Error("设备模拟视口未匹配目标宽度");
    const shot = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await writeFile(output, Buffer.from(shot.data, "base64"));
    // Browser.close may close the socket before the reply is dispatched.
    await cdp.call("Browser.close").catch(() => {});
  } catch (err) {
    throw exited ?? err;
  } finally {
    socket?.close();
    try { await Promise.race([edgeProcess, delay(2000, undefined, { ref: false })]); }
    finally {
      stopEdge.abort();
      await edgeProcess;
    }
  }
}

async function publishCapture(temporary, file) {
  if (!overwrite) return copyFile(temporary, file, constants.COPYFILE_EXCL);
  // Replace only the named new preview, without following a destination symlink.
  const staged = file + "." + randomUUID() + ".tmp";
  try {
    await copyFile(temporary, staged, constants.COPYFILE_EXCL);
    await rename(staged, file);
  } finally {
    await rm(staged, { force: true });
  }
}

async function capture(origin, previewHome, signal) {
  const layouts = mobileOnly ? [] : [{ suffix: "", width: 1250, height: 845 }];
  if (mobile) layouts.push({ suffix: "-mobile", width: 390, height: 844 });
  const pending = [];
  for (const { suffix, width, height } of layouts) {
    const name = outputStem + suffix + ".png";
    const temporary = join(previewHome, name);
    if (suffix) await captureMobile(origin, join(previewHome, "edge-mobile"), temporary, width, height, signal);
    else await exec(edge, [...edgeArgs(origin, join(previewHome, "edge-desktop")),
      "--window-size=" + width + "," + height, "--force-device-scale-factor=1",
      "--virtual-time-budget=7000", "--screenshot=" + temporary, new URL("/ui", origin).href,
    ], { timeout: 45000, windowsHide: true, signal });
    const png = await readFile(temporary);
    if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new Error("Edge 截图尺寸不符: " + name +
        (png.length >= 24 ? " (" + png.readUInt32BE(16) + "×" + png.readUInt32BE(20) + ")" : ""));
    }
    pending.push({ temporary, name, width, height, bytes: png.length });
  }
  for (const { temporary, name, width, height, bytes } of pending) {
    const file = join(outputDir, name);
    await publishCapture(temporary, file);
    console.log(file + " (" + width + "×" + height + ", " + bytes + " bytes)");
  }
}

const previewHome = await mkdtemp(join(tmpdir(), "magpie-newgptpool-preview-"));
const imageDir = join(previewHome, "images");
process.env.MAGPIE_GPTFREE_HOME = join(previewHome, "vault");
process.env.MAGPIE_GPTFREE_IMAGE_DIR = imageDir;
const stop = new AbortController();
const abort = () => stop.abort();
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, abort);
let service;
try {
  const [{ createGuiService }, { createInMemoryStatsStore }, { accountSlotTag }, { recordRequest }] = await Promise.all([
    import("../lib/gui-service.mjs"), import("../lib/pool-stats.mjs"),
    import("../lib/pool-connection.mjs"), import("../lib/request-log.mjs"),
  ]);
  const statsStore = seedStats(createInMemoryStatsStore, accountSlotTag, recordRequest);
  await seedImages(imageDir);
  stop.signal.throwIfAborted();
  service = createGuiService({
    bind: "127.0.0.1", port: 0, sessionFile: false,
    poolRead: async () => rows, statsStore, textQuotaFetcher,
    batch: disabled, poolRemove: disabled, poolSave: disabled, refreshAccount: disabled,
    oauthStart: disabled, oauthOpen: disabled, probeQuota: disabled,
  });
  const addr = await service.listen();
  const origin = "http://127.0.0.1:" + addr.port;
  // Warm the in-memory cache using the same API as the GUI, outside of Edge.
  await primeTextQuota(origin, AbortSignal.any([stop.signal, AbortSignal.timeout(45000)]));
  if (screenshot) {
    await capture(origin, previewHome, stop.signal);
  } else {
    console.log("假数据演示号池：" + origin + "/ui；Ctrl+C 结束。");
    if (!stop.signal.aborted) await new Promise((resolve) => stop.signal.addEventListener("abort", resolve, { once: true }));
  }
} catch (error) {
  if (!stop.signal.aborted) throw error;
} finally {
  try { await service?.close(); }
  finally { await rm(previewHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
