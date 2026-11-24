import { readFile } from "node:fs/promises";
import { parseAccounts, safeAccountName, validateProxyUrl } from "./credentials.mjs";
import { loginHTTPAccount } from "./dsh-http-auth.mjs";
import { extractIdentityFromTokens, refreshCodexToken } from "./web-oauth.mjs";
import { probeAccountImageQuota, verifyAccessToken } from "./codex-pool.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "./pool-connection.mjs";
import { defaultStatsFile } from "./pool-stats.mjs";
import { upsertPool } from "./pool-vault.mjs";
import { defaultBatchLabel, newBatchId, recordBatch } from "./batch-registry.mjs";

/**
 * Import to the separate Magpie token pool. RT rows use the official Codex
 * refresh grant; legacy password rows retain the DSH HTTP authorization path.
 * No Codex CLI command, browser launch or DSH service dependency.
 */
export async function runBatch({
  file, consent = false, dryRun = false, proxy = "", skipInvalid = false,
  mode = "pool", onProgress = () => {}, signal,
  read = readFile, login = loginHTTPAccount,
  verifyToken = verifyAccessToken, savePool = upsertPool, refresh = refreshCodexToken,
  checkQuota, statsFile, statsStore,
  // 一次导入 = 一个批次。CLI 和面板各自传来源，写进批次元数据方便区分。
  source = "cli", batchFile,
} = {}) {
  if (!file || typeof file !== "string") throw new Error("请指定 TXT 或 JSON 文件的完整路径");
  if (mode !== "pool") throw new Error("已移除 Codex CLI 原生导入，请使用 GPTFree号池");
  let raw;
  try { raw = await read(file, "utf8"); }
  catch { throw new Error("无法读取账号导入文件"); }
  const parsed = parseAccounts(raw);
  if (dryRun) {
    return {
      total: parsed.accounts.length, duplicates: parsed.duplicates,
      invalid: parsed.errors, added: 0, failed: [], mode,
      ready: parsed.accounts.map((a) => ({
        line: a.line, email: safeAccountName(a.email),
        has2FA: !!a.totp, kind: a.kind,
        hasRefreshToken: !!a.refreshToken,
        tokenState: a.kind === "access_token" ? a.tokenState : undefined,
      })),
    };
  }
  if (!consent) throw new Error("导入真实账号前必须确认账号的使用授权");
  if (!parsed.accounts.length) throw new Error("导入文件中没有有效账号");
  if (parsed.errors.length && !skipInvalid) throw new Error("账号列表存在格式错误，请先检查导入预览");
  const proxyCheck = validateProxyUrl(proxy);
  if (proxyCheck.error) throw new Error(proxyCheck.error);
  const safeProxy = proxyCheck.proxy;
  const quotaChecker = checkQuota !== undefined
    ? checkQuota
    : (savePool === upsertPool && verifyToken === verifyAccessToken && login === loginHTTPAccount && refresh === refreshCodexToken
      ? probeAccountImageQuota
      : null);
  const quotaTarget = (statsFile !== undefined || statsStore !== undefined)
    ? {
        ...(statsFile !== undefined ? { statsFile } : {}),
        ...(statsStore !== undefined ? { statsStore } : {}),
      }
    : (savePool === upsertPool ? { statsFile: defaultStatsFile() } : { statsFile: null });
  // 批次元数据只在真的走真实号池（或测试显式给了 batchFile）时才写，
  // 免得单测里往真实的 ~/.magpie-gptfree 丢文件。
  const batchTarget = (savePool === upsertPool || batchFile !== undefined)
    ? { ...(batchFile !== undefined ? { file: batchFile } : {}) }
    : null;
  const batchId = newBatchId();
  const batchStartedAt = Date.now();
  const result = {
    total: parsed.accounts.length, added: 0, reused: 0,
    mode, failed: [], duplicates: parsed.duplicates,
    invalid: skipInvalid ? parsed.errors.slice(0, 100).map(({ line, reason }) => ({ line, reason })) : [],
    formats: { standard: 0, mail_link: 0, access_token: 0 },
    tokenNeedsOAuth: 0,
  };
  const rtModelCheck = verifyToken !== verifyAccessToken || (refresh === refreshCodexToken && savePool === upsertPool)
    ? verifyToken : null;
  // Optional RT health checks run after storage and cannot delay later rows or
  // mark a successfully refreshed credential as failed. Bound per-batch fanout.
  let rtHealth = Promise.resolve();
  function scheduleRtHealth(record) {
    if (!rtModelCheck && typeof quotaChecker !== "function") return;
    rtHealth = rtHealth.then(async () => {
      if (signal?.aborted) return;
      const checks = [];
      if (rtModelCheck) checks.push(Promise.resolve().then(() =>
        rtModelCheck(record.accessToken, { expectedEmail: record.email, signal })));
      if (typeof quotaChecker === "function") checks.push(Promise.resolve().then(() =>
        quotaChecker(record, { proxy: safeProxy, signal, ...quotaTarget, reauthenticate: null })));
      await Promise.allSettled(checks);
    }).catch(() => {});
  }
  for (const account of parsed.accounts) {
    if (signal?.aborted) break;
    result.formats[account.kind] = (result.formats[account.kind] ?? 0) + 1;
    const safe = { email: safeAccountName(account.email), line: account.line };
    const slotMeta = (email) => ({ slotTag: accountSlotTag(email), accountLabel: formatAccountSlotLabel(email) });
    let failureReason = "后台 HTTP 授权失败；请检查账号、TOTP、网络或代理。不会自动打开登录网页";
    if (account.kind === "mail_link") {
      // Additional mailbox URL is format metadata, not fetched by the importer.
      onProgress({ state: "mail_link_ignored", ...safe });
    }
    try {
      if (account.kind === "refresh_token") {
        onProgress({ state: "authorizing", ...safe });
        failureReason = "OAuth 续期失败；请检查 Refresh Token、网络或代理";
        let tokens;
        // Once a refresh is dispatched, finish reading its bounded response.
        // Canceling an in-flight exchange could lose an already-rotated RT.
        try { tokens = await refresh({ refreshToken: account.refreshToken, proxy: safeProxy }); }
        catch (err) {
          if (err?.oauthError === "invalid_grant")
            failureReason = "Refresh Token 已失效或已轮换，请重新授权";
          throw err;
        }
        failureReason = "OAuth 返回的账号身份缺失或与导入信息不匹配";
        const identity = extractIdentityFromTokens(tokens, { strict: true });
        if (!identity.email || (account.email && identity.email !== account.email) ||
            (account.expectedAccountId && identity.accountId !== account.expectedAccountId))
          throw new Error(failureReason);
        const savedRecord = {
          email: identity.email, password: "", totp: "",
          accessToken: tokens.accessToken,
          // Keep rotation in the encrypted vault; never rewrite source files.
          refreshToken: tokens.refreshToken || account.refreshToken,
        };
        failureReason = "OAuth 授权成功，但无法写入本地号池";
        await savePool(savedRecord, { batchId });
        result.added++;
        onProgress({ state: "added", ...safe, email: safeAccountName(identity.email), ...slotMeta(identity.email) });
        scheduleRtHealth(savedRecord);
        continue;
      }
      if (account.kind === "access_token") {
        if (account.tokenState === "unexpired_unverified") {
          const probe = await verifyToken(account.accessToken, { expectedEmail: account.email, signal });
          if (probe.accepted) {
            const savedRecord = {
              email: account.email, password: account.password,
              totp: account.totp, accessToken: account.accessToken,
              // TXT 第五列可能带 refresh_token，有就一起存 —— 否则这个号
              // 过期后还得靠密码重登，白瞎了导入时给的续期凭证。
              refreshToken: account.refreshToken || "",
            };
            failureReason = "Token 已通过验证，但无法写入本地号池";
            await savePool(savedRecord, { batchId });
            result.added++;
            result.reused++;
            onProgress({ state: "token_reused", ...safe, ...slotMeta(account.email) });
            if (typeof quotaChecker === "function") {
              await quotaChecker(savedRecord, {
                proxy: safeProxy, signal, ...quotaTarget, reauthenticate: null,
              }).catch(() => {});
            }
            continue;
          }
        }
        result.tokenNeedsOAuth++;
        onProgress({
          state: account.tokenState === "expired" ? "token_expired" : "token_needs_oauth",
          ...safe,
        });
      }
      onProgress({ state: "authorizing", ...safe });
      // DSH Platform HTTP OAuth login, not Codex CLI PKCE or Playwright.
      const { tokens } = await login(account, { signal, proxy: safeProxy });
      // Platform and Codex tokens are not automatically interchangeable.
      // Only a live Codex model response is sufficient for admission.
      failureReason = "DSH HTTP 登录成功，但 Platform Token 未通过 Magpie 模型访问验证";
      const probe = await verifyToken(tokens.access, { expectedEmail: account.email, signal });
      if (!probe?.accepted) throw new Error(failureReason);
      const savedRecord = {
        email: account.email, password: account.password,
        totp: account.totp, accessToken: tokens.access,
        // 登录后端本来就返回了 refresh_token（normalizeWorkerResult 里有），以前丢掉了。
        // 存下来之后这个号过期只需一次 HTTPS 续期，不用再跑 Python 重登。
        refreshToken: tokens.refresh || "",
      };
      failureReason = "HTTP 授权成功，但无法写入本地号池";
      await savePool(savedRecord, { batchId });
      result.added++;
      onProgress({ state: "added", ...safe, ...slotMeta(account.email) });
      if (typeof quotaChecker === "function") {
        await quotaChecker(savedRecord, {
          proxy: safeProxy, signal, ...quotaTarget, reauthenticate: null,
        }).catch(() => {});
      }
    } catch {
      if (signal?.aborted) break;
      // Never return exception messages, including text prefixed with known
      // upstream labels: a server could echo credentials in those messages.
      result.failed.push({ ...safe, reason: failureReason });
      onProgress({ state: "failed", ...safe, reason: failureReason });
    }
  }
  // 一个号都没进池就不记批次 —— 空批次只会在面板里制造噪音。
  if (batchTarget && result.added > 0) {
    await recordBatch({
      id: batchId,
      label: defaultBatchLabel(batchStartedAt, result.added),
      importedAt: new Date(batchStartedAt).toISOString(),
      count: result.added,
      source,
    }, batchTarget).catch(() => {});
  }
  result.batchId = result.added > 0 ? batchId : null;
  if (signal?.aborted) throw new Error("批量导入已取消");
  return result;
}
