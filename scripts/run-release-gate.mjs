import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanupPrivateTemporaryEnvironment,
  createPrivateTemporaryEnvironment,
} from "./private-temporary-environment.mjs";
import { releaseGateEnvironment } from "./release-operator-contract.mjs";

const gatePath = fileURLToPath(new URL("./release-gate.mjs", import.meta.url));
const releaseEnv = releaseGateEnvironment(process.argv.slice(2));
const temporary = createPrivateTemporaryEnvironment({
  baseEnv: releaseEnv,
  prefix: ".clawlore-release-gate-",
});
try {
  const result = spawnSync(process.execPath, [gatePath], {
    cwd: process.cwd(),
    env: temporary.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  cleanupPrivateTemporaryEnvironment(temporary.root);
}
