import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { enforcePrivatePath } from "../../file-privacy.js";
import {
  createEncryptedGenericSnapshotArchiveV2,
  createFileSecretRefKeyProviderV2,
  restoreEncryptedGenericSnapshotArchiveV2,
} from "./encrypted-snapshot-archive.js";
import { inspectGenericSqliteSnapshotV2 } from "./generic-sqlite-snapshot.js";

export interface GenericLiveEncryptedSnapshotReceiptV2 {
  schemaVersion: 1;
  phase: "clawlore-generic-live-encrypted-snapshot";
  createdAt: string;
  status: "pass";
  authorizesWrites: false;
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
    profile: "generic-sqlite-v1";
    schemaDigest: string;
    logicalDigest: string;
    tableCount: number;
    rowCount: number;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
  nextGate: "digest_bound_security_remediation";
}

function opaquePath(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

async function removeSqliteFamily(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

export async function createAndVerifyGenericLiveEncryptedSnapshotV2(input: {
  sourcePath: string;
  archivePath: string;
  restoreTestPath: string;
  receiptPath: string;
  keyId: string;
  secretRefPath: string;
  now?: () => Date;
}): Promise<GenericLiveEncryptedSnapshotReceiptV2> {
  const paths = [input.sourcePath, input.archivePath, input.restoreTestPath, input.receiptPath, input.secretRefPath]
    .map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) throw new Error("generic snapshot workflow paths must be distinct");
  if (existsSync(input.archivePath) || existsSync(input.receiptPath)) {
    throw new Error("generic encrypted snapshot destination already exists");
  }
  if ([input.restoreTestPath, `${input.restoreTestPath}-wal`, `${input.restoreTestPath}-shm`].some(existsSync)) {
    throw new Error("generic restore-test destination already exists");
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const keyProvider = createFileSecretRefKeyProviderV2({
    keyId: input.keyId,
    secretRef: { source: "file", path: input.secretRefPath },
  });
  let completed = false;
  await keyProvider.current();
  const sourceBefore = await inspectGenericSqliteSnapshotV2(input.sourcePath, createdAt);
  try {
    const archive = await createEncryptedGenericSnapshotArchiveV2({
      sourcePath: input.sourcePath,
      archivePath: input.archivePath,
      keyProvider,
      now: () => new Date(createdAt),
    });
    const restored = await restoreEncryptedGenericSnapshotArchiveV2({
      archivePath: input.archivePath,
      destinationPath: input.restoreTestPath,
      expected: archive,
      keyProvider,
      now: input.now,
    });
    const sourceAfter = await inspectGenericSqliteSnapshotV2(input.sourcePath, createdAt);
    if (sourceBefore.schemaDigest !== sourceAfter.schemaDigest
      || sourceBefore.logicalDigest !== sourceAfter.logicalDigest) {
      throw new Error("generic live SQLite changed during encrypted snapshot verification");
    }
    if (restored.schemaDigest !== archive.snapshot.schemaDigest
      || restored.logicalDigest !== archive.snapshot.logicalDigest) {
      throw new Error("generic encrypted live snapshot restore verification mismatch");
    }
    await removeSqliteFamily(input.restoreTestPath);
    if ([input.restoreTestPath, `${input.restoreTestPath}-wal`, `${input.restoreTestPath}-shm`].some(existsSync)) {
      throw new Error("generic encrypted live snapshot plaintext restore cleanup failed");
    }
    const tableCounts = Object.values(archive.snapshot.tableCounts);
    const receipt: GenericLiveEncryptedSnapshotReceiptV2 = {
      schemaVersion: 1,
      phase: "clawlore-generic-live-encrypted-snapshot",
      createdAt,
      status: "pass",
      authorizesWrites: false,
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
        profile: "generic-sqlite-v1",
        schemaDigest: archive.snapshot.schemaDigest,
        logicalDigest: archive.snapshot.logicalDigest,
        tableCount: tableCounts.length,
        rowCount: tableCounts.reduce((sum, count) => sum + count, 0),
        integrity: "ok",
        foreignKeyViolations: 0,
      },
      nextGate: "digest_bound_security_remediation",
    };
    await mkdir(dirname(input.receiptPath), { recursive: true });
    await writeFile(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    enforcePrivatePath(input.receiptPath, { kind: "file" });
    completed = true;
    return receipt;
  } finally {
    await removeSqliteFamily(input.restoreTestPath);
    if (!completed) {
      await Promise.all([rm(input.archivePath, { force: true }), rm(input.receiptPath, { force: true })]);
    }
  }
}
