import { join } from "node:path";
import { withPrivateFileLock } from "./private-file-lock.js";

/** Serialize cross-process writes to SQL truth and its vector companion. */
export async function withMemoryWriteLock<T>(dbPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(dbPath, ".memory-write.lock");
  return withPrivateFileLock(lockPath, operation);
}
