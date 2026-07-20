import { dirname } from "node:path";
import {
  enforcePrivatePath,
  ensurePrivateDirectory,
  writePrivateFileExclusive,
} from "./file-privacy.js";

/** Ensure proper-lockfile receives a private regular file, never a symlink. */
export async function ensurePrivateLockFile(path: string): Promise<void> {
  ensurePrivateDirectory(dirname(path));
  try {
    await writePrivateFileExclusive(path, "");
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    enforcePrivatePath(path, { kind: "file" });
  }
}
