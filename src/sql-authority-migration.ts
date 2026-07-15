import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { enforcePrivatePath } from "./file-privacy.js";
import { SqlTruthStore, type SqlTruthAuthorityInspection } from "./sql-truth-store.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface LegacyAuthorityMigrationPlan {
  status: "ready" | "blocked";
  reason: string;
  truthRows: number | null;
  sourceDatabase: string;
  backupDatabase: string;
  receiptFile: string;
}

export interface LegacyAuthorityMigrationReceipt {
  version: 1;
  status: "prepared" | "completed" | "failed";
  migrationId: string;
  sourceDatabase: string;
  backupDatabase: string;
  backupSha256: string;
  sourceTruthRows: number;
  preparedAt: string;
  completedAt?: string;
  failureCode?: string;
  postInspection?: SqlTruthAuthorityInspection;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  enforcePrivatePath(directory, { kind: "directory" });
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
  const inspection = SqlTruthStore.inspectAuthority(params.sqlitePath);
  const output = {
    truthRows: inspection.truthRows,
    sourceDatabase: basename(params.sqlitePath),
    backupDatabase: basename(params.backupPath),
    receiptFile: basename(params.receiptPath),
  };
  if (inspection.status !== "legacy") {
    return { status: "blocked", reason: `source_authority_${inspection.status}`, ...output };
  }
  if (existsSync(params.backupPath)) {
    return { status: "blocked", reason: "backup_already_exists", ...output };
  }
  if (existsSync(params.receiptPath)) {
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
  const plan = inspectLegacyAuthorityMigration(params);
  if (plan.status !== "ready" || plan.truthRows === null) {
    throw new Error(`CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: ${plan.reason}`);
  }
  const backupDirectory = dirname(params.backupPath);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  enforcePrivatePath(backupDirectory, { kind: "directory" });

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const source = new DatabaseSync(params.sqlitePath);
  try {
    const quickCheck = String(source.prepare("PRAGMA quick_check").get()?.quick_check || "");
    if (quickCheck !== "ok") {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source quick_check failed");
    }
    source.prepare("VACUUM INTO ?").run(params.backupPath);
  } finally {
    source.close();
  }
  enforcePrivatePath(params.backupPath, { kind: "file" });
  const backupInspection = SqlTruthStore.inspectAuthority(params.backupPath);
  if (backupInspection.status !== "legacy" || backupInspection.truthRows !== plan.truthRows) {
    throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup authority verification failed");
  }
  const backupSha256 = await sha256File(params.backupPath);
  const migrationId = randomUUID();
  const preparedAt = new Date().toISOString();
  let receipt: LegacyAuthorityMigrationReceipt = {
    version: 1,
    status: "prepared",
    migrationId,
    sourceDatabase: basename(params.sqlitePath),
    backupDatabase: basename(params.backupPath),
    backupSha256,
    sourceTruthRows: plan.truthRows,
    preparedAt,
  };
  writePrivateJsonAtomic(params.receiptPath, receipt);

  try {
    const completedAt = Date.now();
    const postInspection = SqlTruthStore.upgradeLegacyAuthority(
      params.sqlitePath,
      {
        migrationId,
        backupSha256,
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
    writePrivateJsonAtomic(params.receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt = {
      ...receipt,
      status: "failed",
      failureCode: diagnosticErrorSummary(error),
    };
    try { writePrivateJsonAtomic(params.receiptPath, receipt); } catch {}
    throw error;
  }
}
