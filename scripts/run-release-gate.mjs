import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseGateEnvironment } from "./release-operator-contract.mjs";

const gatePath = fileURLToPath(new URL("./release-gate.mjs", import.meta.url));
const env = releaseGateEnvironment(process.argv.slice(2));
const result = spawnSync(process.execPath, [gatePath], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
