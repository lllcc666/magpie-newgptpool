import { createHmac } from "node:crypto";

const EMAIL = /^[^\s@\x00-\x1F\x7F]+@[^\s@\x00-\x1F\x7F]+\.[^\s@\x00-\x1F\x7F]+$/;
const BASE32 = /^[A-Z2-7]+=*$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const MAX_ACCOUNTS = 100;
export const MAX_BYTES = 1024 * 1024;

const SEP_STRICT = /-{3,}/g;
const SEP_LOOSE = /-{2,}/g;

function splitBy(line, re) {
  const fields = [];
  let start = 0, match;
  re.lastIndex = 0;
  while (fields.length < 3 && (match = re.exec(line))) {
    fields.push(line.slice(start, match.index).trim());
    start = re.lastIndex;
  }
  fields.push(line.slice(start).trim());
  return fields;
}

function looksLikeSeed(value) {
  const seed = String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
  return BASE32.test(seed) && seed.replace(/=+$/, "").length >= 16;
}

/**
 * Split on at most the first THREE separators; any dashes inside the last
 * URL/token remain untouched. Canonical separator is `----` (or `---`), but
 * a line written as `邮箱--密码--2FA` is accepted too: an e-mail address and a
 * Base32 secret never contain a dash, so `--` is unambiguous for the first
 * three columns. `--` is only a fallback, so files mixing both styles parse.
 */
export function splitAccountLine(line) {
  const strict = splitBy(line, SEP_STRICT);
  if (strict.length === 1) {
    const loose = splitBy(line, SEP_LOOSE);
    return loose.length > 1 ? loose : strict;
  }
  // Mixed line such as `a@b.com----pw--SECRET`: strict mode only finds two
  // columns, but a `--` split puts a real third column at the end.
  const loose = splitBy(line, SEP_LOOSE);
  const third = loose[2] ?? "";
  if (loose.length > strict.length &&
      (looksLikeSeed(third) || /^https?:\/\//i.test(third) || third.startsWith("eyJ"))) {
    return loose;
  }
  return strict;
}

function jwtPayload(token) {
  try {
    const raw = token.split(".")[1];
    if (!raw || raw.length > 65536) return null;
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Local claims are never cryptographic validation. Even "unexpired" does
 * NOT mean OpenAI has accepted the token or granted Codex permission.
 */
export function accessTokenState(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8192 || !JWT.test(token))
    return { state: "invalid" };
  const payload = jwtPayload(token);
  if (!payload) return { state: "invalid" };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp))
    return { state: "unknown" };
  const time = Math.floor(now / 1000);
  if (payload.exp <= time + 120) return { state: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > time + 60)
    return { state: "not_yet_valid" };
  return { state: "unexpired_unverified" };
}

function validateSafeHttpUrl(raw, errorLabel) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
        u.username || u.password || raw.length > 8192) {
      return { error: errorLabel };
    }
    return { ok: true, url: raw };
  } catch {
    return { error: errorLabel };
  }
}

export function validateProxyUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: true, proxy: "" };
  let u;
  try { u = new URL(value); } catch {
    return { error: "代理地址格式不正确" };
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
      u.username || u.password || value.length > 512) {
    return { error: "代理只允许无认证的 http(s) URL" };
  }
  return { ok: true, proxy: value };
}

/**
 * Split the 4th column into (col4, col5) when a 5th column was appended.
 * `----` always wins. `--` is only used when the tail is clearly a URL, so a
 * JWT signature that happens to contain `--` is never cut in half — a 5-column
 * line therefore has to use `----` (see FORK.md).
 */
function splitFourth(value) {
  const cut = (index, length) => [
    value.slice(0, index).trim(),
    value.slice(index + length).trim(),
  ];
  const strict = /-{3,}/.exec(value);
  if (strict) return cut(strict.index, strict[0].length);
  const beforeUrl = /-{2,}(?=https?:\/\/)/i.exec(value);
  if (beforeUrl) return cut(beforeUrl.index, beforeUrl[0].length);
  return null;
}

function classifyFourth(value, loose = false) {
  if (!value) return { error: "第四字段为空" };
  if (/^https?:\/\//i.test(value)) {
    const check = validateSafeHttpUrl(value, "邮箱链接格式不正确");
    if (check.error) return check;
    // Metadata only: not fetched, never sent to a different host.
    return { kind: "mail_link", mailUrl: check.url };
  }
  const split = splitFourth(value);
  if (split) {
    const [rawCol4, rawCol5] = split;
    if (!rawCol4) return { error: "第四字段为空" };
    if (!rawCol5) return { error: "第五字段为空" };
    const tok4 = rawCol4.replace(/^Bearer\s+/i, "").trim();
    if (tok4.startsWith("eyJ")) {
      const info4 = accessTokenState(tok4);
      if (info4.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
      if (/^https?:\/\//i.test(rawCol5)) {
        const url5 = validateSafeHttpUrl(rawCol5, "第五字段邮箱链接格式不正确");
        if (url5.error) return url5;
        return { kind: "access_token", accessToken: tok4, tokenState: info4.state, mailUrl: url5.url };
      }
      if (rawCol5.length > 8192 || /[\r\n\0\s]/.test(rawCol5))
        return { error: "第五字段 Token 格式不正确" };
      // 第五列就是 refresh_token。以前只记了个 hasRefreshToken 布尔、值直接扔掉，
      // 于是这个号照样得靠密码反复重登 —— 现在把值带出去落库。
      return {
        kind: "access_token", accessToken: tok4, tokenState: info4.state,
        hasRefreshToken: true, refreshToken: rawCol5,
      };
    }
    const tok5 = rawCol5.replace(/^Bearer\s+/i, "").trim();
    if (tok5.startsWith("eyJ") && rawCol4.length <= 8192 && !/[\r\n\0\s]/.test(rawCol4)) {
      const info5 = accessTokenState(tok5);
      if (info5.state === "invalid") return { error: "第五字段 JWT Token 格式不正确" };
      // 反过来写的顺序：第四列是 refresh_token，第五列才是 access_token。
      return {
        kind: "access_token", accessToken: tok5, tokenState: info5.state,
        hasRefreshToken: true, refreshToken: rawCol4,
      };
    }
  }
  const token = value.replace(/^Bearer\s+/i, "").trim();
  if (token.startsWith("eyJ")) {
    // A JWT signature may contain `--`, so a `--`-separated 5th column cannot
    // be told apart from a signature tail. Refuse rather than glue them.
    if (loose && token.includes("--"))
      return { error: "Token 与后面的列请用 3 个以上连字符分隔" };
    const info = accessTokenState(token);
    if (info.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
    return { kind: "access_token", accessToken: token, tokenState: info.state };
  }
  if (EXPLICIT_RT.test(value)) {
    if (!isRefreshToken(value)) return { error: "第四字段 Refresh Token 格式不正确" };
    return { kind: "refresh_token", hasRefreshToken: true, refreshToken: value };
  }
  return { error: "第四字段只能是 http(s) 邮箱链接、JWT access_token 或 Refresh Token" };
}

export function normalizeAccountEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && EMAIL.test(email) ? email : "";
}

const RT = /^[A-Za-z0-9._~+/=-]{16,8192}$/;
const EXPLICIT_RT = /^rt(?:[_-]|\.\d+\.)/;
const JSON_START = /^[{[\"]/;
const RT_ERROR = "应为每行一个 Refresh Token、邮箱 + RT、旧账号 TXT 或受支持的 JSON";

function isRefreshToken(value) {
  return typeof value === "string" && RT.test(value) && !/^rt\.\d+\.$/.test(value) &&
    !(value.startsWith("eyJ") && JWT.test(value));
}

function rtRecord(refreshToken, email = "", expectedAccountId = "") {
  return {
    kind: "refresh_token", email, password: "", totp: "",
    hasRefreshToken: true, refreshToken, expectedAccountId,
  };
}

function parseLegacyLine(line, cols) {
  const [rawEmail, password, rawSeed = "", fourth] = cols;
  const email = normalizeAccountEmail(rawEmail);
  const totp = rawSeed.replace(/[\s-]/g, "").toUpperCase();
  if (!email) return { error: "邮箱格式不正确" };
  if (!password || password.length > 512 || /[\r\n\0]/.test(password))
    return { error: "密码为空或太长" };
  if (totp && (!BASE32.test(totp) || totp.replace(/=+$/, "").length < 16))
    return { error: "2FA密钥不是合法的 Base32 TOTP Secret" };
  const extra = cols.length === 4 ? classifyFourth(fourth, !/-{3,}/.test(line)) : { kind: "standard" };
  return extra.error ? extra : { email, password, totp, ...extra };
}

function parseTextLine(line) {
  // A bare RT with a recognizable prefix may contain runs of dashes.
  // Otherwise don't reinterpret a malformed legacy line as a token.
  if (isRefreshToken(line) && (EXPLICIT_RT.test(line) || !/-{2,}/.test(line)))
    return rtRecord(line);
  const cols = splitAccountLine(line);
  const legacy = cols.length >= 2 ? parseLegacyLine(line, cols) : { error: RT_ERROR };
  if (cols.length > 2 && !legacy.error) return legacy;
  const alternate = /^([^\s@|,:]+@[^\s@|,:]+?)(?:\s*[|,]\s*|\s+)(\S+)$/.exec(line);
  if (alternate && isRefreshToken(alternate[2])) {
    const email = normalizeAccountEmail(alternate[1]);
    if (email) return rtRecord(alternate[2], email);
  }
  // Two dash-delimited fields are also the old email/password syntax. Only
  // unmistakably prefixed values select RT here; tab/pipe/comma/space are
  // available for opaque tokens. Split once to preserve dashes inside the RT.
  const dashed = /^(\S+?@\S+?)\s*-{2,}\s*(\S+)$/.exec(line);
  const email = dashed && normalizeAccountEmail(dashed[1]);
  if (email && EXPLICIT_RT.test(dashed[2])) {
    if (isRefreshToken(dashed[2])) return rtRecord(dashed[2], email);
    return { error: "Refresh Token 格式不正确" };
  }
  return legacy;
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function parseJsonRecord(value) {
  if (value.platform && value.platform !== "openai")
    return { error: "只支持 OpenAI OAuth 账号" };
  if (value.type && !["codex", "oauth", "rt"].includes(value.type))
    return { error: "只支持 CPA Codex、Sub2API OAuth 和 RT JSON" };
  const sources = [value, value.credentials, value.tokens].filter(isObject);
  const readFields = (fields) => sources.flatMap((source) =>
    fields.map((key) => source[key]).filter((v) => v !== undefined && v !== null && v !== ""));
  const rtValues = new Set(readFields(["refresh_token", "refreshToken"]).map((v) => typeof v === "string" ? v.trim() : v));
  const refreshToken = rtValues.values().next().value;
  if (rtValues.size !== 1 || !isRefreshToken(refreshToken))
    return { error: "JSON 中缺少唯一有效的 Refresh Token" };
  const emails = new Set(readFields(["email"]).map(normalizeAccountEmail));
  if (emails.size > 1 || emails.has(""))
    return { error: "JSON 中的邮箱格式无效或相互冲突" };
  const ids = new Set(readFields(["chatgpt_account_id", "account_id", "chatgptAccountId", "accountId"])
    .map((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(v.trim()) ? v.trim() : ""));
  if (ids.size > 1 || ids.has(""))
    return { error: "JSON 中的账号 ID 无效或相互冲突" };
  // Imported access/id tokens, proxy settings, and other document fields are
  // never used for identity or requests. The official refresh response is.
  return rtRecord(refreshToken, emails.values().next().value, ids.values().next().value);
}

export function parseAccounts(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES)
    throw new Error("账号文件超过 1 MiB 或不是 UTF-8 文本");
  const accounts = [], errors = [], seenEmails = new Map(), seenRTs = new Map();
  let duplicates = 0;
  const add = (record, line) => {
    if (record.error) { errors.push({ line, reason: record.error }); return; }
    if (record.kind === "refresh_token" && seenRTs.has(record.refreshToken)) {
      const previous = seenRTs.get(record.refreshToken);
      if (!previous) { duplicates++; return; }
      if ((previous.email && record.email && previous.email !== record.email) ||
          (previous.expectedAccountId && record.expectedAccountId && previous.expectedAccountId !== record.expectedAccountId)) {
        // Conflicting identity hints must not be bypassed with skip-invalid.
        const index = accounts.indexOf(previous);
        if (index >= 0) accounts.splice(index, 1);
        if (seenEmails.get(previous.email) === previous) seenEmails.delete(previous.email);
        seenRTs.set(record.refreshToken, null);
        errors.push({ line, reason: "同一 Refresh Token 的身份信息相互冲突" });
        return;
      }
      if (!previous.email && record.email) {
        previous.email = record.email;
        if (!seenEmails.has(record.email)) seenEmails.set(record.email, previous);
      }
      previous.expectedAccountId ||= record.expectedAccountId;
      duplicates++;
      return;
    }
    // Remember RTs even when this row is skipped for an already-listed email;
    // a later anonymous occurrence must not bypass the skipped identity hint.
    if (record.kind === "refresh_token") seenRTs.set(record.refreshToken, record);
    if (record.email && seenEmails.has(record.email)) { duplicates++; return; }
    record.line = line;
    accounts.push(record);
    if (record.email) seenEmails.set(record.email, record);
    if (accounts.length > MAX_ACCOUNTS)
      throw new Error("单次最多导入 100 个账号；请分批执行");
  };
  const source = content.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  const skipped = (line) => !line || /^(?:#|\/\/|refresh_?token$)/i.test(line);
  const asText = (text, line, json = false) => {
    const value = text.trim();
    if (!skipped(value)) add(json && !/[@]/.test(value)
      ? (isRefreshToken(value) ? rtRecord(value) : { error: RT_ERROR }) : parseTextLine(value), line);
  };
  let jsonItem = 0;
  function walk(value, sourceLine, depth = 0) {
    if (depth > 12) { add({ error: "JSON 嵌套过深" }, sourceLine || ++jsonItem); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, sourceLine, depth + 1); return; }
    if (isObject(value) && Array.isArray(value.accounts)) { walk(value.accounts, sourceLine, depth + 1); return; }
    if (isObject(value) && (isObject(value.data) || Array.isArray(value.data))) { walk(value.data, sourceLine, depth + 1); return; }
    const line = sourceLine || ++jsonItem;
    if (typeof value === "string") { asText(value, line, true); return; }
    add(isObject(value) ? parseJsonRecord(value) : { error: "JSON 项不是账号对象或 RT" }, line);
  }
  if (JSON_START.test(source.trimStart())) {
    let value;
    try { value = JSON.parse(source); } catch {}
    if (value !== undefined) walk(value);
    else {
      const entries = lines.map((text, i) => [text.trim(), i + 1]).filter(([text]) => !skipped(text));
      if (entries.length > 1 && entries.every(([text]) => JSON_START.test(text))) {
        for (const [text, line] of entries) {
          let item;
          try { item = JSON.parse(text); } catch {}
          if (item === undefined) add({ error: "JSON 语法错误" }, line);
          else walk(item, line);
        }
      } else add({ error: "JSON 语法错误" }, entries[0]?.[1] || 1);
    }
  } else {
    for (const [i, raw] of lines.entries()) asText(raw, i + 1);
  }
  return { accounts, errors, duplicates };
}

export function totpCode(seed, now = Date.now()) {
  const normalized = String(seed).toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized))
    throw new Error("TOTP Secret 无效");
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const ch of normalized) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits -= 8)) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  const time = BigInt(Math.floor(now / 30000));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(time);
  const hash = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const n = hash[hash.length - 1] & 0x0f;
  return String(((hash.readUInt32BE(n) & 0x7fffffff) % 1000000)).padStart(6, "0");
}

export function safeAccountName(email) {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) return "待 OAuth 确认";
  const [name, domain] = normalized.split("@");
  return name.length <= 2 ? "*@" + domain : name.slice(0, 2) + "***@" + domain;
}
