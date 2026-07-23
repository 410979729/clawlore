import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { withPrivateFileLock } from "../../private-file-lock.js";
import type { MemoryProjectionV2 } from "../domain/memory-record.js";

function projectionFenceStripe(itemId: string, projection: MemoryProjectionV2): string {
  // A bounded stripe set avoids retaining one lock file for every historical
  // item. Hash collisions only serialize unrelated mutations; they cannot
  // weaken the ordering guarantee for the same item and projection.
  return createHash("sha256")
    .update(itemId)
    .update("\0")
    .update(projection)
    .digest("hex")
    .slice(0, 2);
}

/**
 * Serialize one item's projection mutations across workers and processes.
 *
 * The outbox guarantees oldest-pending-first order. This per-item/projection
 * fence closes the remaining lease-expiry window: a takeover can claim work,
 * but it cannot apply a newer mutation until the older adapter call has
 * finished and released this lock.
 */
export function withProjectionApplyFence<T>(
  sqlitePath: string,
  itemId: string,
  projection: MemoryProjectionV2,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(
    dirname(sqlitePath),
    ".clawlore-projection-locks",
    `${projectionFenceStripe(itemId, projection)}.lock`,
  );
  return withPrivateFileLock(lockPath, operation);
}
