import { ensurePrivateLockFile } from "./private-lock-file.js";

let lockfileModule: any = null;

async function loadLockfile(): Promise<any> {
  if (!lockfileModule) lockfileModule = await import("proper-lockfile");
  return lockfileModule;
}

/**
 * Run an operation under a private cross-process file lock.
 *
 * proper-lockfile refreshes the lock while the operation is active, so a
 * legitimately slow operation cannot be taken over solely because it crossed
 * the stale interval.
 */
export async function withPrivateFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockfile = await loadLockfile();
  await ensurePrivateLockFile(lockPath);
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2_000 },
    stale: 10_000,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
