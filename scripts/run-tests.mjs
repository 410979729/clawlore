import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  cleanupPrivateTemporaryEnvironment,
  createPrivateTemporaryEnvironment,
} from "./private-temporary-environment.mjs";

const temporary = createPrivateTemporaryEnvironment({
  prefix: ".clawlore-test-",
});
const env = temporary.env;

try {
  if (process.platform === "win32") {
    // Some service-launched Windows shells omit Git for Windows from PATH
    // even though the canonical repository and release tooling require it.
    const gitProbe = spawnSync("git", ["--version"], { env, stdio: "ignore", shell: false });
    if (gitProbe.error) {
      const gitCmd = [
        process.env.ProgramW6432,
        process.env.ProgramFiles,
        "C:\\Program Files",
      ]
        .filter(Boolean)
        .map((root) => join(root, "Git", "cmd"))
        .find((directory) => existsSync(join(directory, "git.exe")));
      if (gitCmd) {
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
        env[pathKey] = `${gitCmd}${delimiter}${env[pathKey] ?? ""}`;
      }
    }
  }

  const result = spawnSync(process.execPath, ["--test", "tests/*.test.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  cleanupPrivateTemporaryEnvironment(temporary.root);
}
