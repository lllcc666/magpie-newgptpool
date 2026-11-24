import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./", import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort();
const home = mkdtempSync(join(tmpdir(), "magpie-gptpool-tests-"));
try {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MAGPIE_GPTFREE_|HOME$|USERPROFILE$)/i.test(name)) delete env[name];
  }
  // Some test cases clear the vault override, so isolate the OS home fallback too.
  Object.assign(env, { HOME: home, USERPROFILE: home, MAGPIE_GPTFREE_HOME: join(home, "pool") });
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map((name) => join(dir, name))], {
    env, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) console.error(`Test runner stopped by ${result.signal}`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
