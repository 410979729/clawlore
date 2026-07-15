import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { PrivatePathOptions } from "./file-privacy.js";
import { enforcePrivatePath } from "./file-privacy.js";

export interface OAuthSessionReadOptions extends PrivatePathOptions {
  beforeOpen?: () => void | Promise<void>;
}

function sameFileIdentity(
  expected: { dev: number | bigint; ino: number | bigint },
  actual: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(expected.dev) === String(actual.dev) && String(expected.ino) === String(actual.ino);
}

export async function readOAuthSessionFile(
  authPath: string,
  options: OAuthSessionReadOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const directory = dirname(authPath);
  enforcePrivatePath(directory, { kind: "directory", platform, execFile: options.execFile });

  const initial = await lstat(authPath);
  if (initial.isSymbolicLink()) {
    throw new Error("CLAWLORE_OAUTH_UNSAFE_AUTH_PATH: symbolic links are not readable OAuth authorities");
  }
  if (!initial.isFile()) {
    throw new Error("CLAWLORE_OAUTH_UNSAFE_AUTH_PATH: OAuth authority must be a regular file");
  }
  enforcePrivatePath(authPath, { kind: "file", platform, execFile: options.execFile });
  const expected = await lstat(authPath);
  await options.beforeOpen?.();

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(authPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error("CLAWLORE_OAUTH_SECURE_OPEN_FAILED", { cause: error });
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(expected, opened)) {
      throw new Error("CLAWLORE_OAUTH_FILE_IDENTITY_CHANGED");
    }
    if (platform !== "win32") {
      const mode = opened.mode & 0o777;
      if (mode !== 0o600) {
        throw new Error("CLAWLORE_OAUTH_FILE_MODE_INVALID");
      }
      if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
        throw new Error("CLAWLORE_OAUTH_FILE_OWNER_INVALID");
      }
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
