import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceOnly = process.argv.includes("--source-only");
const gatePath = fileURLToPath(new URL("./release-gate.mjs", import.meta.url));
const env = {
  ...process.env,
  CLAWLORE_ALLOW_NESTED_GIT_ROOT: "1",
  ...(sourceOnly ? { CLAWLORE_SOURCE_ONLY: "1" } : {}),
};
const result = spawnSync(process.execPath, [gatePath], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
