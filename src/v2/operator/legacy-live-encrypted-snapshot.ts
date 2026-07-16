import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { enforcePrivatePath } from "../../file-privacy.js";
import {
  createEncryptedLegacySnapshotArchiveV2,
  createFileSecretRefKeyProviderV2,
  restoreEncryptedLegacySnapshotArchiveV2,
} from "./encrypted-snapshot-archive.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";

export interface LegacyLiveEncryptedSnapshotReceiptV2 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-encrypted-snapshot";
  createdAt: string;
  status: "pass";
  authorizesV2Writes: false;
  sourceRef: string;
  archiveRef: string;
  keyRef: string;
  keyId: string;
  algorithm: "aes-256-gcm";
  archiveSha256: string;
  archiveBytes: number;
  sourceStableDuringBackup: true;
  restoreVerified: true;
  restoredPlaintextRemoved: true;
  snapshot: {
    schemaDigest: string;
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
  nextGate: "fresh_v2_write_readiness_and_plan_validation";
}

function opaquePath(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 20);
}

async function removeSqliteFamily(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

export async function createAndVerifyLegacyLiveEncryptedSnapshotV2(input: {
  sourcePath: string;
  archivePath: string;
  restoreTestPath: string;
  receiptPath: string;
  keyId: string;
  secretRefPath: string;
  now?: () => Date;
}): Promise<LegacyLiveEncryptedSnapshotReceiptV2> {
  const paths = [input.sourcePath, input.archivePath, input.restoreTestPath, input.receiptPath, input.secretRefPath]
    .map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) throw new Error("snapshot workflow paths must be distinct");
  if (existsSync(input.archivePath)) throw new Error("encrypted archive destination already exists");
  if (existsSync(input.receiptPath)) throw new Error("snapshot receipt destination already exists");
  if ([input.restoreTestPath, `${input.restoreTestPath}-wal`, `${input.restoreTestPath}-shm`].some(existsSync)) {
    throw new Error("restore-test destination already exists");
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const keyProvider = createFileSecretRefKeyProviderV2({
    keyId: input.keyId,
    secretRef: { source: "file", path: input.secretRefPath },
  });
  let completed = false;
  await keyProvider.current();
  const sourceBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath, createdAt);
  try {
    const archive = await createEncryptedLegacySnapshotArchiveV2({
      sourcePath: input.sourcePath,
      archivePath: input.archivePath,
      keyProvider,
      now: () => new Date(createdAt),
    });
    const restored = await restoreEncryptedLegacySnapshotArchiveV2({
      archivePath: input.archivePath,
      destinationPath: input.restoreTestPath,
      expected: archive,
      keyProvider,
      now: input.now,
    });
    const sourceAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath, createdAt);
    const sourceStableDuringBackup = sourceBefore.schemaDigest === sourceAfter.schemaDigest
      && sourceBefore.memoryTruth.rowCount === sourceAfter.memoryTruth.rowCount
      && sourceBefore.memoryTruth.logicalDigest === sourceAfter.memoryTruth.logicalDigest;
    if (!sourceStableDuringBackup) throw new Error("live legacy truth changed during encrypted snapshot verification");
    if (restored.schemaDigest !== archive.snapshot.schemaDigest
      || restored.memoryTruth.rowCount !== archive.snapshot.memoryTruth.rowCount
      || restored.memoryTruth.logicalDigest !== archive.snapshot.memoryTruth.logicalDigest) {
      throw new Error("encrypted live snapshot restore verification mismatch");
    }
    const receipt: LegacyLiveEncryptedSnapshotReceiptV2 = {
      schemaVersion: 1,
      phase: "clawlore-v2-live-encrypted-snapshot",
      createdAt,
      status: "pass",
      authorizesV2Writes: false,
      sourceRef: opaquePath(input.sourcePath),
      archiveRef: opaquePath(input.archivePath),
      keyRef: opaquePath(input.secretRefPath),
      keyId: archive.keyId,
      algorithm: archive.algorithm,
      archiveSha256: archive.archiveSha256,
      archiveBytes: archive.bytes,
      sourceStableDuringBackup: true,
      restoreVerified: true,
      restoredPlaintextRemoved: true,
      snapshot: {
        schemaDigest: archive.snapshot.schemaDigest,
        memoryTruthRows: archive.snapshot.memoryTruth.rowCount,
        memoryTruthLogicalDigest: archive.snapshot.memoryTruth.logicalDigest,
        integrity: archive.snapshot.integrity,
        foreignKeyViolations: 0,
      },
      nextGate: "fresh_v2_write_readiness_and_plan_validation",
    };
    await mkdir(dirname(input.receiptPath), { recursive: true });
    await writeFile(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    enforcePrivatePath(input.receiptPath, { kind: "file" });
    completed = true;
    return receipt;
  } finally {
    await removeSqliteFamily(input.restoreTestPath);
    if (!completed) {
      await Promise.all([
        rm(input.archivePath, { force: true }),
        rm(input.receiptPath, { force: true }),
      ]);
    }
  }
}
