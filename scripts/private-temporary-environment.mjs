import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";

export function privateTemporaryParent(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return options.temp ?? tmpdir();
  const declared = String(
    (options.env ?? process.env).CLAWLORE_PRIVATE_TEMP_ROOT ?? "",
  ).trim();
  return declared
    ? win32.resolve(declared)
    : win32.resolve(options.home ?? homedir());
}

/**
 * Windows' shared temp directory may be writable by other local principals.
 * Release and test subprocesses that exercise ClawLore's production privacy
 * checks therefore receive a per-run temp root below the trusted user profile.
 */
export function createPrivateTemporaryEnvironment(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = { ...(options.baseEnv ?? process.env) };
  if (platform !== "win32") return { env, root: undefined };

  const create = options.create ?? mkdtempSync;
  const root = create(join(
    options.home ?? homedir(),
    options.prefix ?? ".clawlore-run-",
  ));
  env.TEMP = root;
  env.TMP = root;
  env.CLAWLORE_PRIVATE_TEMP_ROOT = root;
  return { env, root };
}

export function cleanupPrivateTemporaryEnvironment(root, options = {}) {
  if (!root) return;
  const remove = options.remove ?? rmSync;
  remove(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
