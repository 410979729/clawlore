import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { createRequire } from "node:module";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { enforcePrivatePath, verifyPrivatePath } from "./file-privacy.js";
import { SqlTruthStore, type SqlTruthAuthorityInspection } from "./sql-truth-store.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface LegacyAuthorityMigrationPlan {
  status: "ready" | "recoverable" | "blocked";
  reason: string;
  truthRows: number | null;
  sourceDatabase: string;
  backupDatabase: string;
  receiptFile: string;
}

export interface LegacyAuthorityMigrationReceipt {
  version: 2;
  status: "prepared" | "completed" | "failed";
  migrationId: string;
  sourceDatabase: string;
  backupDatabase: string;
  backupSha256: string;
  sourceSnapshotSha256: string;
  sourceTruthRows: number;
  preparedAt: string;
  backupDurableAt: string;
  lockProtocol: "sqlite-begin-immediate-snapshot-digest";
  completedAt?: string;
  recoveredAt?: string;
  failureCode?: string;
  postInspection?: SqlTruthAuthorityInspection;
}

interface InternalMigrationEvidence {
  migrationId: string;
  sourceTruthRows: number;
  backupSha256: string;
  sourceSnapshotSha256: string;
  completedAt: number;
}

interface CanonicalMigrationPaths {
  sqlitePath: string;
  backupPath: string;
  receiptPath: string;
  backupDirectory: string;
  receiptDirectory: string;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalTargetPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  if (!existsSync(parent)) return absolute;
  return join(realpathSync.native(parent), basename(absolute));
}

function canonicalMigrationPaths(params: {
  sqlitePath: string;
  backupPath: string;
  receiptPath: string;
}): CanonicalMigrationPaths {
  const sqlitePath = realpathSync.native(resolve(params.sqlitePath));
  const backupPath = canonicalTargetPath(params.backupPath);
  const receiptPath = canonicalTargetPath(params.receiptPath);
  const keys = [sqlitePath, backupPath, receiptPath].map(pathKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source, backup, and receipt paths must be distinct");
  }
  const sourceCompanions = [`${sqlitePath}-wal`, `${sqlitePath}-shm`].map(pathKey);
  if (sourceCompanions.includes(pathKey(backupPath)) || sourceCompanions.includes(pathKey(receiptPath))) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: migration output aliases a SQLite companion path");
  }
  const backupDirectory = dirname(backupPath);
  const receiptDirectory = dirname(receiptPath);
  if (pathKey(backupDirectory) === pathKey(receiptDirectory)) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup and receipt require separate private directories");
  }
  const dangerousDirectories = new Set([
    pathKey(parse(backupDirectory).root),
    pathKey(homedir()),
    pathKey(tmpdir()),
    pathKey(dirname(sqlitePath)),
  ]);
  for (const directory of [backupDirectory, receiptDirectory]) {
    if (dangerousDirectories.has(pathKey(directory))) {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: migration outputs require dedicated private leaf directories");
    }
  }
  return { sqlitePath, backupPath, receiptPath, backupDirectory, receiptDirectory };
}

function inspectPrivateLeafDirectory(directory: string, allowedEntries: string[] = []): string | null {
  if (!existsSync(directory)) {
    return existsSync(dirname(directory)) ? null : "directory_parent_missing";
  }
  try {
    verifyPrivatePath(directory, { kind: "directory" });
  } catch {
    return "directory_not_private";
  }
  const allowed = new Set(allowedEntries);
  if (readdirSync(directory).some((entry) => !allowed.has(entry))) return "directory_not_dedicated";
  return null;
}

function preparePrivateLeafDirectory(directory: string): boolean {
  if (existsSync(directory)) {
    verifyPrivatePath(directory, { kind: "directory" });
    return false;
  }
  if (!existsSync(dirname(directory))) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: private leaf parent does not exist");
  }
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  enforcePrivatePath(directory, { kind: "directory" });
  return true;
}

function fsyncFileAndParent(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") {
    const directoryFd = openSync(dirname(path), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}

function readInternalMigrationEvidence(sqlitePath: string): InternalMigrationEvidence | null {
  const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
  if (inspection.status !== "valid") return null;
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT m.migration_id, m.source_truth_rows, m.backup_sha256,
             m.source_snapshot_sha256, m.completed_at
      FROM clawlore_sql_truth_authority AS a
      JOIN clawlore_sql_truth_migrations AS m ON m.migration_id = a.migration_id
      WHERE a.singleton = 1 AND a.origin = 'legacy-upgrade'
      LIMIT 1
    `).get() as {
      migration_id?: string;
      source_truth_rows?: number;
      backup_sha256?: string;
      source_snapshot_sha256?: string;
      completed_at?: number;
    } | undefined;
    if (!row?.migration_id || !row.backup_sha256 || !row.source_snapshot_sha256) return null;
    return {
      migrationId: row.migration_id,
      sourceTruthRows: Number(row.source_truth_rows),
      backupSha256: row.backup_sha256,
      sourceSnapshotSha256: row.source_snapshot_sha256,
      completedAt: Number(row.completed_at),
    };
  } finally {
    db.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const directory = dirname(path);
  verifyPrivatePath(directory, { kind: "directory" });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    enforcePrivatePath(temporary, { kind: "file" });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    enforcePrivatePath(path, { kind: "file" });
    if (process.platform !== "win32") {
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function inspectLegacyAuthorityMigration(params: {
  sqlitePath: string;
  backupPath: string;
  receiptPath: string;
}): LegacyAuthorityMigrationPlan {
  const fallbackOutput = {
    truthRows: null,
    sourceDatabase: basename(params.sqlitePath),
    backupDatabase: basename(params.backupPath),
    receiptFile: basename(params.receiptPath),
  };
  let paths: CanonicalMigrationPaths;
  try {
    paths = canonicalMigrationPaths(params);
  } catch (error) {
    return {
      status: "blocked",
      reason: diagnosticErrorSummary(error),
      ...fallbackOutput,
    };
  }
  const inspection = SqlTruthStore.inspectAuthority(paths.sqlitePath);
  const output = { ...fallbackOutput, truthRows: inspection.truthRows };
  const backupDirectoryIssue = inspectPrivateLeafDirectory(
    paths.backupDirectory,
    existsSync(paths.backupPath) ? [basename(paths.backupPath)] : [],
  );
  const receiptDirectoryIssue = inspectPrivateLeafDirectory(
    paths.receiptDirectory,
    existsSync(paths.receiptPath) ? [basename(paths.receiptPath)] : [],
  );
  if (backupDirectoryIssue) {
    return { status: "blocked", reason: `backup_${backupDirectoryIssue}`, ...output };
  }
  if (receiptDirectoryIssue) {
    return { status: "blocked", reason: `receipt_${receiptDirectoryIssue}`, ...output };
  }
  if (inspection.status === "valid") {
    const internal = readInternalMigrationEvidence(paths.sqlitePath);
    if (!internal || !existsSync(paths.backupPath)) {
      return { status: "blocked", reason: "source_authority_valid", ...output };
    }
    let externalStatus: string | null = null;
    if (existsSync(paths.receiptPath)) {
      try {
        externalStatus = String(JSON.parse(readFileSync(paths.receiptPath, "utf8")).status || "");
      } catch {
        externalStatus = "unreadable";
      }
    }
    if (externalStatus === "completed") {
      return { status: "blocked", reason: "migration_already_completed", ...output };
    }
    return {
      status: "recoverable",
      reason: "internal_migration_committed_external_receipt_recoverable",
      ...output,
      truthRows: internal.sourceTruthRows,
    };
  }
  if (inspection.status !== "legacy") {
    return { status: "blocked", reason: `source_authority_${inspection.status}`, ...output };
  }
  if (existsSync(paths.backupPath)) {
    return { status: "blocked", reason: "backup_already_exists", ...output };
  }
  if (existsSync(paths.receiptPath)) {
    return { status: "blocked", reason: "receipt_already_exists", ...output };
  }
  return { status: "ready", reason: "legacy_authority_verified", ...output };
}

export async function migrateLegacySqlAuthority(params: {
  sqlitePath: string;
  backupPath: string;
  receiptPath: string;
  faultInjector?: (point: string) => void;
}): Promise<LegacyAuthorityMigrationReceipt> {
  const paths = canonicalMigrationPaths(params);
  const plan = inspectLegacyAuthorityMigration(params);
  if (plan.status === "recoverable") {
    return recoverLegacySqlAuthorityReceipt(paths);
  }
  if (plan.status !== "ready" || plan.truthRows === null) {
    throw new Error(`CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: ${plan.reason}`);
  }
  const createdBackupDirectory = preparePrivateLeafDirectory(paths.backupDirectory);
  const createdReceiptDirectory = preparePrivateLeafDirectory(paths.receiptDirectory);
  try {

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const source = new DatabaseSync(paths.sqlitePath);
  try {
    const quickCheck = String(source.prepare("PRAGMA quick_check").get()?.quick_check || "");
    if (quickCheck !== "ok") {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source quick_check failed");
    }
    params.faultInjector?.("backup_before_vacuum");
    source.prepare("VACUUM INTO ?").run(paths.backupPath);
    params.faultInjector?.("backup_after_vacuum");
  } finally {
    source.close();
  }
  enforcePrivatePath(paths.backupPath, { kind: "file" });
  params.faultInjector?.("backup_before_fsync");
  fsyncFileAndParent(paths.backupPath);
  params.faultInjector?.("backup_after_fsync");
  const sourceStatus = statSync(paths.sqlitePath);
  const backupStatus = statSync(paths.backupPath);
  if (sourceStatus.dev === backupStatus.dev && sourceStatus.ino === backupStatus.ino) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup aliases source identity");
  }
  const backupInspection = SqlTruthStore.inspectAuthority(paths.backupPath);
  if (backupInspection.status !== "legacy" || backupInspection.truthRows !== plan.truthRows) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup authority verification failed");
  }
  const sourceSnapshotSha256 = SqlTruthStore.legacySnapshotDigest(paths.backupPath);
  const backupSha256 = await sha256File(paths.backupPath);
  const migrationId = randomUUID();
  const preparedAt = new Date().toISOString();
  const backupDurableAt = new Date().toISOString();
  let receipt: LegacyAuthorityMigrationReceipt = {
    version: 2,
    status: "prepared",
    migrationId,
    sourceDatabase: basename(paths.sqlitePath),
    backupDatabase: basename(paths.backupPath),
    backupSha256,
    sourceSnapshotSha256,
    sourceTruthRows: plan.truthRows,
    preparedAt,
    backupDurableAt,
    lockProtocol: "sqlite-begin-immediate-snapshot-digest",
  };
  writePrivateJsonAtomic(paths.receiptPath, receipt);

  try {
    const completedAt = Date.now();
    const postInspection = SqlTruthStore.upgradeLegacyAuthority(
      paths.sqlitePath,
      {
        migrationId,
        backupSha256,
        sourceSnapshotSha256,
        sourceTruthRows: plan.truthRows,
        completedAt,
      },
      params.faultInjector,
    );
    receipt = {
      ...receipt,
      status: "completed",
      completedAt: new Date(completedAt).toISOString(),
      postInspection,
    };
    params.faultInjector?.("external_receipt_before_completed_write");
    writePrivateJsonAtomic(paths.receiptPath, receipt);
    return receipt;
  } catch (error) {
    const internal = readInternalMigrationEvidence(paths.sqlitePath);
    if (internal?.migrationId === migrationId) {
      try {
        return await recoverLegacySqlAuthorityReceipt(paths);
      } catch (recoveryError) {
        throw new Error(
          "CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REQUIRED: database migration committed but external receipt needs reconciliation",
          { cause: recoveryError },
        );
      }
    }
    receipt = {
      ...receipt,
      status: "failed",
      failureCode: diagnosticErrorSummary(error),
    };
    try { writePrivateJsonAtomic(paths.receiptPath, receipt); } catch {}
    throw error;
  }
  } finally {
    if (
      !existsSync(paths.receiptPath) &&
      existsSync(paths.backupPath) &&
      SqlTruthStore.inspectAuthority(paths.sqlitePath).status === "legacy"
    ) {
      rmSync(paths.backupPath, { force: true });
    }
    for (const [directory, created] of [
      [paths.backupDirectory, createdBackupDirectory],
      [paths.receiptDirectory, createdReceiptDirectory],
    ] as const) {
      if (!created || !existsSync(directory)) continue;
      try {
        if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true, force: false });
      } catch {}
    }
  }
}

async function recoverLegacySqlAuthorityReceipt(
  paths: CanonicalMigrationPaths,
): Promise<LegacyAuthorityMigrationReceipt> {
  const internal = readInternalMigrationEvidence(paths.sqlitePath);
  if (!internal) {
    throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: internal migration evidence missing");
  }
  verifyPrivatePath(paths.backupDirectory, { kind: "directory" });
  verifyPrivatePath(paths.receiptDirectory, { kind: "directory" });
  verifyPrivatePath(paths.backupPath, { kind: "file" });
  const backupSha256 = await sha256File(paths.backupPath);
  if (backupSha256 !== internal.backupSha256) {
    throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: backup digest mismatch");
  }
  const backupInspection = SqlTruthStore.inspectAuthority(paths.backupPath);
  const sourceSnapshotSha256 = SqlTruthStore.legacySnapshotDigest(paths.backupPath);
  if (
    backupInspection.status !== "legacy" ||
    backupInspection.truthRows !== internal.sourceTruthRows ||
    sourceSnapshotSha256 !== internal.sourceSnapshotSha256
  ) {
    throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: backup snapshot mismatch");
  }
  let prior: Partial<LegacyAuthorityMigrationReceipt> = {};
  if (existsSync(paths.receiptPath)) {
    try { prior = JSON.parse(readFileSync(paths.receiptPath, "utf8")); } catch {}
  }
  const receipt: LegacyAuthorityMigrationReceipt = {
    version: 2,
    status: "completed",
    migrationId: internal.migrationId,
    sourceDatabase: basename(paths.sqlitePath),
    backupDatabase: basename(paths.backupPath),
    backupSha256: internal.backupSha256,
    sourceSnapshotSha256: internal.sourceSnapshotSha256,
    sourceTruthRows: internal.sourceTruthRows,
    preparedAt: typeof prior.preparedAt === "string"
      ? prior.preparedAt
      : new Date(statSync(paths.backupPath).mtimeMs).toISOString(),
    backupDurableAt: typeof prior.backupDurableAt === "string"
      ? prior.backupDurableAt
      : new Date(statSync(paths.backupPath).mtimeMs).toISOString(),
    lockProtocol: "sqlite-begin-immediate-snapshot-digest",
    completedAt: new Date(internal.completedAt).toISOString(),
    recoveredAt: new Date().toISOString(),
    postInspection: SqlTruthStore.inspectAuthority(paths.sqlitePath),
  };
  writePrivateJsonAtomic(paths.receiptPath, receipt);
  return receipt;
}
