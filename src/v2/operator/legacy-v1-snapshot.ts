import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createOnlineSqliteBackupV2 } from "./sqlite-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

const REQUIRED_MEMORY_TRUTH_COLUMNS = [
  "id",
  "text",
  "category",
  "scope",
  "timestamp",
  "metadata",
] as const;

export interface LegacySqliteSnapshotManifestV2 {
  schemaVersion: 1;
  profile: "scope-recall-legacy-v1";
  createdAt: string;
  sha256: string;
  bytes: number;
  integrity: "ok";
  foreignKeyViolations: number;
  userVersion: number;
  tableCount: number;
  schemaDigest: string;
  memoryTruth: {
    rowCount: number;
    columns: string[];
    logicalDigest: string;
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function openReadOnly(path: string): DatabaseSync {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: object) => DatabaseSync;
  };
  return new DatabaseSync(path, { readOnly: true });
}

function scalar(row: Record<string, unknown>, fallback = 0): number {
  const value = Number(Object.values(row)[0] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return String(value);
}

export async function inspectLegacySqliteSnapshotV2(
  path: string,
  createdAt = new Date().toISOString(),
): Promise<LegacySqliteSnapshotManifestV2> {
  const db = openReadOnly(path);
  try {
    const integrityRow = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const integrity = String(integrityRow.integrity_check ?? Object.values(integrityRow)[0] ?? "");
    if (integrity !== "ok") throw new Error(`legacy snapshot integrity check failed: ${integrity}`);

    const foreignKeyViolations = scalar(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get() as Record<string, unknown>,
    );
    if (foreignKeyViolations !== 0) {
      throw new Error(`legacy snapshot foreign key check failed: ${foreignKeyViolations}`);
    }

    const tableRows = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
      name: string;
      sql: string | null;
    }>;
    if (!tableRows.some((row) => row.name === "memory_truth")) {
      throw new Error("legacy snapshot memory_truth table not found");
    }
    const schemaDigest = createHash("sha256")
      .update(JSON.stringify(tableRows.map((row) => [String(row.name), String(row.sql ?? "")])))
      .digest("hex");

    const columns = (db.prepare("PRAGMA table_info(memory_truth)").all() as Array<{ name: string }>)
      .map((row) => String(row.name));
    const columnSet = new Set(columns);
    for (const required of REQUIRED_MEMORY_TRUTH_COLUMNS) {
      if (!columnSet.has(required)) {
        throw new Error(`legacy snapshot memory_truth missing required column: ${required}`);
      }
    }

    const logicalHash = createHash("sha256");
    let rowCount = 0;
    const rows = db.prepare(`SELECT id,text,category,scope,timestamp,metadata
      FROM memory_truth ORDER BY id`).iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      rowCount += 1;
      logicalHash.update(JSON.stringify(REQUIRED_MEMORY_TRUTH_COLUMNS.map((column) => stableValue(row[column]))));
      logicalHash.update("\n");
    }

    const info = await stat(path);
    const userVersion = scalar(db.prepare("PRAGMA user_version").get() as Record<string, unknown>);
    return {
      schemaVersion: 1,
      profile: "scope-recall-legacy-v1",
      createdAt,
      sha256: await sha256File(path),
      bytes: info.size,
      integrity: "ok",
      foreignKeyViolations,
      userVersion,
      tableCount: tableRows.length,
      schemaDigest,
      memoryTruth: { rowCount, columns, logicalDigest: logicalHash.digest("hex") },
    };
  } finally {
    db.close();
  }
}

export async function createVerifiedLegacySqliteSnapshotV2(input: {
  sourcePath: string;
  destinationPath: string;
  now?: () => Date;
}): Promise<LegacySqliteSnapshotManifestV2> {
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  await createOnlineSqliteBackupV2(input.sourcePath, input.destinationPath);
  try {
    return await inspectLegacySqliteSnapshotV2(input.destinationPath, createdAt);
  } catch (error) {
    await rm(input.destinationPath, { force: true });
    throw error;
  }
}

export async function restoreVerifiedLegacySqliteSnapshotV2(input: {
  snapshotPath: string;
  destinationPath: string;
  expected: LegacySqliteSnapshotManifestV2;
  now?: () => Date;
}): Promise<LegacySqliteSnapshotManifestV2> {
  if (existsSync(input.destinationPath)) throw new Error("restore destination already exists");
  const source = await inspectLegacySqliteSnapshotV2(input.snapshotPath, input.expected.createdAt);
  if (source.sha256 !== input.expected.sha256) throw new Error("legacy snapshot checksum mismatch");
  if (source.schemaDigest !== input.expected.schemaDigest) throw new Error("legacy snapshot schema mismatch");
  if (source.memoryTruth.logicalDigest !== input.expected.memoryTruth.logicalDigest
    || source.memoryTruth.rowCount !== input.expected.memoryTruth.rowCount) {
    throw new Error("legacy snapshot truth manifest mismatch");
  }
  await createOnlineSqliteBackupV2(input.snapshotPath, input.destinationPath);
  try {
    const restored = await inspectLegacySqliteSnapshotV2(
      input.destinationPath,
      (input.now?.() ?? new Date()).toISOString(),
    );
    if (restored.schemaDigest !== source.schemaDigest
      || restored.memoryTruth.logicalDigest !== source.memoryTruth.logicalDigest
      || restored.memoryTruth.rowCount !== source.memoryTruth.rowCount) {
      throw new Error("restored legacy database verification mismatch");
    }
    return restored;
  } catch (error) {
    await rm(input.destinationPath, { force: true });
    throw error;
  }
}
