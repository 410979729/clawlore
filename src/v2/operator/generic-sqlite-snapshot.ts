import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { quoteIdentifier } from "../../persisted-secret-scan.js";
import { createOnlineSqliteBackupV2 } from "./sqlite-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface GenericSqliteSnapshotManifestV2 {
  schemaVersion: 1;
  profile: "generic-sqlite-v1";
  createdAt: string;
  sha256: string;
  bytes: number;
  schemaDigest: string;
  logicalDigest: string;
  integrity: "ok";
  foreignKeyViolations: number;
  tableCounts: Record<string, number>;
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

function normalizedValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? { blobBase64: value.toString("base64") } : value;
}

function stableRows(db: DatabaseSync, table: string): string[] {
  const statement = `SELECT * FROM ${quoteIdentifier(table)}`;
  const rows = db.prepare(statement).all() as Array<Record<string, unknown>>;
  return rows.map((row) => JSON.stringify(Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizedValue(value)]),
  ))).sort();
}

export async function inspectGenericSqliteSnapshotV2(
  path: string,
  createdAt = new Date().toISOString(),
): Promise<GenericSqliteSnapshotManifestV2> {
  const { DatabaseSync: Database } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
  };
  const db = new Database(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const integrityRow = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const integrity = String(integrityRow.integrity_check ?? Object.values(integrityRow)[0] ?? "");
    if (integrity !== "ok") throw new Error("generic SQLite snapshot integrity check failed");
    const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (foreignKeyViolations !== 0) throw new Error("generic SQLite snapshot foreign key check failed");
    const schemaRows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as Array<Record<string, unknown>>;
    const schemaDigest = createHash("sha256").update(JSON.stringify(schemaRows)).digest("hex");
    const tables = schemaRows
      .filter((row) => row.type === "table" && typeof row.name === "string")
      .map((row) => String(row.name));
    const logicalHash = createHash("sha256");
    const tableCounts: Record<string, number> = {};
    for (const table of tables) {
      const rows = stableRows(db, table);
      tableCounts[table] = rows.length;
      logicalHash.update(`${table}\0${rows.length}\0`);
      for (const row of rows) logicalHash.update(`${row}\0`);
    }
    const info = await stat(path);
    return {
      schemaVersion: 1,
      profile: "generic-sqlite-v1",
      createdAt,
      sha256: await sha256File(path),
      bytes: info.size,
      schemaDigest,
      logicalDigest: logicalHash.digest("hex"),
      integrity: "ok",
      foreignKeyViolations: 0,
      tableCounts,
    };
  } finally {
    db.close();
  }
}

export async function createVerifiedGenericSqliteSnapshotV2(input: {
  sourcePath: string;
  destinationPath: string;
  now?: () => Date;
}): Promise<GenericSqliteSnapshotManifestV2> {
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  await createOnlineSqliteBackupV2(input.sourcePath, input.destinationPath);
  try {
    return await inspectGenericSqliteSnapshotV2(input.destinationPath, createdAt);
  } catch (error) {
    await rm(input.destinationPath, { force: true });
    throw error;
  }
}

export async function restoreVerifiedGenericSqliteSnapshotV2(input: {
  snapshotPath: string;
  destinationPath: string;
  expected: GenericSqliteSnapshotManifestV2;
  now?: () => Date;
}): Promise<GenericSqliteSnapshotManifestV2> {
  const source = await inspectGenericSqliteSnapshotV2(input.snapshotPath, input.expected.createdAt);
  if (source.sha256 !== input.expected.sha256
    || source.schemaDigest !== input.expected.schemaDigest
    || source.logicalDigest !== input.expected.logicalDigest) {
    throw new Error("generic SQLite snapshot manifest mismatch");
  }
  await createOnlineSqliteBackupV2(input.snapshotPath, input.destinationPath);
  try {
    const restored = await inspectGenericSqliteSnapshotV2(
      input.destinationPath,
      (input.now?.() ?? new Date()).toISOString(),
    );
    if (restored.schemaDigest !== source.schemaDigest
      || restored.logicalDigest !== source.logicalDigest
      || JSON.stringify(restored.tableCounts) !== JSON.stringify(source.tableCounts)) {
      throw new Error("generic SQLite restored database verification mismatch");
    }
    return restored;
  } catch (error) {
    await rm(input.destinationPath, { force: true });
    throw error;
  }
}
