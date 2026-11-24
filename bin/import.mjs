#!/usr/bin/env node
import { runBatch } from "../lib/importer.mjs";

const args = process.argv.slice(2);
const showHelp = () => {
  console.log(`Magpie GPTFree standalone batch importer

用法：
  magpie-newgptpool --file accounts.txt --dry-run
  magpie-newgptpool --file accounts.txt --i-own-these-accounts --mode pool
  node bin/import.mjs --file accounts.txt --i-own-these-accounts

可选：
  --proxy http://127.0.0.1:7890        指定可信的 HTTP(S) 代理
  --dry-run                            只统计解析结果（不登录、不写号池）
  --skip-invalid                       跳过格式错误行，仅导入有效账号
  --mode pool                          仅支持独立 HTTP Token 号池（默认）
  --i-own-these-accounts               确认账号归属/管理权
  --help                               查看帮助

旧版 TXT 格式：邮箱----密码----Base32 TOTP密钥[----邮箱链接/Token][----RefreshToken]；没有 2FA 可仅填邮箱----密码。
同时支持每行一个 RT、邮箱----RT、邮箱 + Tab + RT、邮箱----密码----TOTP----RT，以及 CPA/Codex 与 Sub2API 凭据 JSON。
邮箱----RT 识别 rt_、rt- 和 rt.1. 等版本化前缀；无明确前缀的 RT 请用 Tab 分隔，以免被当作密码。
RT（包括 JSON）需由本插件默认的 Codex OAuth 客户端签发，续期只用官方接口。旧密码行仍走 DSH 后台授权；不打开登录浏览器。
`);
};
if (args.includes("--help") || args.includes("-h")) { showHelp(); process.exit(0); }
const get = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : ""; };
const file = get("--file") || args.find((x) => !x.startsWith("-") && !args[args.indexOf(x) - 1]?.startsWith("--"));
if (!file) { showHelp(); process.exitCode = 2; }
else {
  try {
    const result = await runBatch({
      file,
      mode: get("--mode") || "pool",
      proxy: get("--proxy") || "",
      skipInvalid: args.includes("--skip-invalid"),
      dryRun: args.includes("--dry-run"),
      consent: args.includes("--i-own-these-accounts"),
      onProgress: ({ state, line, reason }) => {
        console.log(`第 ${line} 项: ${state}${reason ? " (" + reason + ")" : ""}`);
      },
    });
    if (args.includes("--dry-run")) {
      console.log(`有效 ${result.total}，重复 ${result.duplicates}，错误 ${result.invalid.length}`);
      if (result.invalid.length) process.exitCode = 2;
    } else {
      console.log(`模式: ${result.mode}; 成功: ${result.added}/${result.total}; 复用有效 Token: ${result.reused}; 失败: ${result.failed.length}，重复: ${result.duplicates}`);
      if (result.failed.length) process.exitCode = 1;
    }
  } catch (err) {
    console.error(String(err?.message || "导入失败"));
    process.exitCode = 2;
  }
}
