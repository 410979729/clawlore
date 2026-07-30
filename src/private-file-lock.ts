import { ensurePrivateLockFile } from "./private-lock-file.js";

let lockfileModule: any = null;

// Native module initialization has produced event-loop stalls near 150 seconds
// on the Windows Gateway. Keep the stale window above that measured pause so a
// healthy writer is not mistaken for an abandoned process.
export const PRIVATE_FILE_LOCK_STALE_MS = 5 * 60 * 1000;
export const PRIVATE_FILE_LOCK_UPDATE_MS = 30_000;

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
    stale: PRIVATE_FILE_LOCK_STALE_MS,
    update: PRIVATE_FILE_LOCK_UPDATE_MS,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
