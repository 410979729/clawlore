import { join } from "node:path";
import { ensurePrivateLockFile } from "./private-lock-file.js";
let lockfileModule = null;
async function loadLockfile() {
    if (!lockfileModule)
        lockfileModule = await import("proper-lockfile");
    return lockfileModule;
}
/** Serialize cross-process writes to SQL truth and its vector companion. */
export async function withMemoryWriteLock(dbPath, operation) {
    const lockfile = await loadLockfile();
    const lockPath = join(dbPath, ".memory-write.lock");
    await ensurePrivateLockFile(lockPath);
    const release = await lockfile.lock(lockPath, {
        retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2_000 },
        stale: 10_000,
    });
    try {
        return await operation();
    }
    finally {
        await release();
    }
}
