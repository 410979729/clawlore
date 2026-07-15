import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { MemoryEntry, MemorySearchResult } from "./store.js";
import { parseSmartMetadata, isMemoryActiveAt } from "./smart-metadata.js";
import { enforcePrivatePath, ensurePrivateDirectory } from "./file-privacy.js";

const require = createRequire(import.meta.url);

type DatabaseSync = any;

function runSql(db: DatabaseSync, statement: string): void {
  (db as Record<string, (sql: string) => void>)["exec"](statement);
}

interface SqlRow {
  id: string;
  text: string;
  category: MemoryEntry["category"];
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  metadata_text: string;
  raw_bm25?: number | null;
}

interface ScopeClause {
  sql: string;
  params: unknown[];
}

export interface SqlTruthStats {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}

export interface SqlTruthFtsReport {
  truthRows: number;
  ftsRows: number;
  staleFtsRows: number;
  missingFtsRows: number;
  duplicateFtsExtraRows: number;
  healthy: boolean;
  reason?: string;
}

export interface VectorRepairDebtReport {
  pending: number;
  oldestCreatedAt: number | null;
  latestUpdatedAt: number | null;
}

export interface VectorRepairDebtEntry {
  memoryId: string;
  action: "upsert" | "delete";
  operation: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export type SqlTruthAuthorityStatus = "missing" | "valid" | "legacy" | "untrusted" | "unreadable";

export interface SqlTruthAuthorityInspection {
  status: SqlTruthAuthorityStatus;
  schemaVersion: number | null;
  truthRows: number | null;
  reason: string;
}

export interface SqlTruthOpenOptions {
  allowCreate?: boolean;
}

export interface SqlTruthLegacyUpgradeEvidence {
  migrationId: string;
  backupSha256: string;
  sourceSnapshotSha256: string;
  sourceTruthRows: number;
  completedAt: number;
}

const SQL_TRUTH_AUTHORITY_TABLE = "clawlore_sql_truth_authority";
const SQL_TRUTH_MIGRATION_TABLE = "clawlore_sql_truth_migrations";
const SQL_TRUTH_AUTHORITY_ID = "clawlore-sql-truth";
const SQL_TRUTH_AUTHORITY_SCHEMA_VERSION = 3;
const REQUIRED_TRUTH_COLUMNS = [
  "id",
  "text",
  "category",
  "scope",
  "importance",
  "timestamp",
  "metadata",
  "metadata_text",
  "updated_at",
] as const;
const REQUIRED_FTS_COLUMNS = ["memory_id", "text", "metadata_text"] as const;
const REQUIRED_AUTHORITY_COLUMNS = [
  "singleton",
  "authority_id",
  "schema_version",
  "origin",
  "migration_id",
  "backup_sha256",
  "schema_fingerprint",
  "created_at",
  "updated_at",
] as const;
const REQUIRED_MIGRATION_COLUMNS = [
  "migration_id",
  "source_truth_rows",
  "backup_sha256",
  "source_snapshot_sha256",
  "completed_at",
] as const;

const TRUTH_TABLE_SQL = `CREATE TABLE IF NOT EXISTS memory_truth (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  scope TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0,
  timestamp REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  metadata_text TEXT NOT NULL DEFAULT '',
  updated_at REAL NOT NULL DEFAULT 0
)`;
const FTS_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS memory_truth_fts USING fts5(
  memory_id UNINDEXED,
  text,
  metadata_text
)`;
const SCOPE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_memory_truth_scope_timestamp
  ON memory_truth(scope, timestamp DESC)`;
const CATEGORY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_memory_truth_category_timestamp
  ON memory_truth(category, timestamp DESC)`;
const REPAIR_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_companion_repair_outbox (
  memory_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'delete')),
  operation TEXT NOT NULL,
  last_error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
)`;
const REPAIR_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_vector_companion_repair_updated_at
  ON vector_companion_repair_outbox(updated_at ASC)`;
const AUTHORITY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SQL_TRUTH_AUTHORITY_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  authority_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('fresh', 'legacy-upgrade')),
  migration_id TEXT,
  backup_sha256 TEXT,
  schema_fingerprint TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
)`;
const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SQL_TRUTH_MIGRATION_TABLE} (
  migration_id TEXT PRIMARY KEY,
  source_truth_rows INTEGER NOT NULL,
  backup_sha256 TEXT NOT NULL,
  source_snapshot_sha256 TEXT NOT NULL,
  completed_at REAL NOT NULL
)`;
const ACTIVE_FACT_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS memory_truth_single_active_fact_insert
  BEFORE INSERT ON memory_truth
  WHEN json_extract(NEW.metadata, '$.fact_key') IS NOT NULL
    AND COALESCE(json_extract(NEW.metadata, '$.invalidated_at'), 0) = 0
    AND COALESCE(json_extract(NEW.metadata, '$.superseded_by'), '') = ''
    AND EXISTS (
      SELECT 1 FROM memory_truth AS current
      WHERE current.scope = NEW.scope
        AND current.id != NEW.id
        AND json_extract(current.metadata, '$.fact_key') = json_extract(NEW.metadata, '$.fact_key')
        AND COALESCE(json_extract(current.metadata, '$.invalidated_at'), 0) = 0
        AND COALESCE(json_extract(current.metadata, '$.superseded_by'), '') = ''
    )
  BEGIN
    SELECT RAISE(ABORT, 'active fact_key uniqueness violation');
  END`;
const ACTIVE_FACT_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS memory_truth_single_active_fact_update
  BEFORE UPDATE OF scope, metadata ON memory_truth
  WHEN json_extract(NEW.metadata, '$.fact_key') IS NOT NULL
    AND COALESCE(json_extract(NEW.metadata, '$.invalidated_at'), 0) = 0
    AND COALESCE(json_extract(NEW.metadata, '$.superseded_by'), '') = ''
    AND EXISTS (
      SELECT 1 FROM memory_truth AS current
      WHERE current.scope = NEW.scope
        AND current.id != NEW.id
        AND json_extract(current.metadata, '$.fact_key') = json_extract(NEW.metadata, '$.fact_key')
        AND COALESCE(json_extract(current.metadata, '$.invalidated_at'), 0) = 0
        AND COALESCE(json_extract(current.metadata, '$.superseded_by'), '') = ''
    )
  BEGIN
    SELECT RAISE(ABORT, 'active fact_key uniqueness violation');
  END`;

const EXPECTED_SCHEMA_OBJECTS = [
  ["memory_truth", "table", TRUTH_TABLE_SQL],
  ["memory_truth_fts", "table", FTS_TABLE_SQL],
  ["idx_memory_truth_scope_timestamp", "index", SCOPE_INDEX_SQL],
  ["idx_memory_truth_category_timestamp", "index", CATEGORY_INDEX_SQL],
  ["vector_companion_repair_outbox", "table", REPAIR_TABLE_SQL],
  ["idx_vector_companion_repair_updated_at", "index", REPAIR_INDEX_SQL],
  [SQL_TRUTH_AUTHORITY_TABLE, "table", AUTHORITY_TABLE_SQL],
  [SQL_TRUTH_MIGRATION_TABLE, "table", MIGRATION_TABLE_SQL],
  ["memory_truth_single_active_fact_insert", "trigger", ACTIVE_FACT_INSERT_TRIGGER_SQL],
  ["memory_truth_single_active_fact_update", "trigger", ACTIVE_FACT_UPDATE_TRIGGER_SQL],
] as const;

function normalizeSchemaSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\bif\s+not\s+exists\b/g, "")
    .replace(/[\"`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=])\s*/g, "$1")
    .trim()
    .replace(/;$/, "");
}

function schemaFingerprintFromObjects(objects: Array<readonly [string, string, string]>): string {
  const hash = createHash("sha256");
  for (const [name, type, sql] of [...objects].sort((a, b) => a[0].localeCompare(b[0]))) {
    hash.update(`${name}\u0000${type}\u0000${normalizeSchemaSql(sql)}\n`);
  }
  return hash.digest("hex");
}

const SQL_TRUTH_SCHEMA_FINGERPRINT = schemaFingerprintFromObjects([...EXPECTED_SCHEMA_OBJECTS]);

function actualSchemaFingerprint(db: DatabaseSync): string | null {
  const names = EXPECTED_SCHEMA_OBJECTS.map(([name]) => name);
  const placeholders = names.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT name, type, sql FROM sqlite_master WHERE name IN (${placeholders})`,
  ).all(...names) as Array<{ name: string; type: string; sql?: string | null }>;
  if (rows.length !== EXPECTED_SCHEMA_OBJECTS.length || rows.some((row) => !row.sql)) return null;
  return schemaFingerprintFromObjects(rows.map((row) => [row.name, row.type, String(row.sql)] as const));
}

function legacySnapshotDigestFromDb(db: DatabaseSync): string {
  const hash = createHash("sha256");
  const coreObjects = db.prepare(
    "SELECT name, type, sql FROM sqlite_master WHERE name IN ('memory_truth','memory_truth_fts') ORDER BY name",
  ).all() as Array<{ name: string; type: string; sql?: string | null }>;
  for (const row of coreObjects) {
    hash.update(`${row.name}\u0000${row.type}\u0000${normalizeSchemaSql(String(row.sql || ""))}\n`);
  }
  for (const row of db.prepare(`SELECT id,text,category,scope,importance,timestamp,metadata,metadata_text,updated_at
    FROM memory_truth ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
    hash.update(`${JSON.stringify(row)}\n`);
  }
  for (const row of db.prepare(`SELECT memory_id,text,metadata_text
    FROM memory_truth_fts ORDER BY memory_id,text,metadata_text`).iterate() as Iterable<Record<string, unknown>>) {
    hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
const MAX_LIST_LIMIT = 10_000;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function queryTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of (text || "").toLowerCase().matchAll(WORD_RE)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function buildFtsQuery(tokens: string[]): string {
  return tokens
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, " ")}"`)
    .join(" OR ");
}

function metadataSearchText(metadata: string): string {
  if (!metadata) return "";
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return [
      parsed.l0_abstract,
      parsed.l1_overview,
      parsed.l2_content,
      parsed.keywords,
      parsed.entities,
      parsed.tags,
      parsed.category,
      parsed.tier,
    ]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");
  } catch {
    return metadata;
  }
}

function scoreLexicalHit(query: string, text: string, metadataText: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;

  const haystack = `${text}\n${metadataText}`.toLowerCase();
  const queryTokenSet = new Set(queryTokens(query));
  const docTokenSet = new Set(queryTokens(haystack));
  let overlap = 0;
  for (const token of queryTokenSet) {
    if (docTokenSet.has(token)) overlap++;
  }
  const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
  const phraseBonus = haystack.includes(normalizedQuery) ? 0.35 : 0;
  return Math.max(0, Math.min(1, overlapScore * 0.68 + phraseBonus));
}

function normalizeBm25(rawScores: Map<string, number>): Map<string, number> {
  if (rawScores.size === 0) return new Map();
  const values = [...rawScores.values()].filter(Number.isFinite);
  if (values.length === 0) return new Map();
  const best = Math.min(...values);
  const worst = Math.max(...values);
  if (best === worst) {
    return new Map([...rawScores.keys()].map((id) => [id, 1]));
  }
  const span = worst - best;
  return new Map(
    [...rawScores.entries()].map(([id, value]) => [
      id,
      Math.max(0, Math.min(1, (worst - value) / span)),
    ]),
  );
}

function toMemoryEntry(row: SqlRow): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    vector: [],
    category: row.category,
    scope: row.scope || "global",
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: row.metadata || "{}",
  };
}

export class SqlTruthStore {
  private db: DatabaseSync | null = null;
  private savepointSequence = 0;
  private privacyEstablished = false;
  private skipWindowsPrivacyCheckInTransaction = false;

  constructor(
    private readonly sqlitePath: string,
    private readonly faultInjector?: (point: string) => void,
  ) {}

  get path(): string {
    return this.sqlitePath;
  }

  static inspectAuthority(sqlitePath: string): SqlTruthAuthorityInspection {
    if (!existsSync(sqlitePath)) {
      return {
        status: "missing",
        schemaVersion: null,
        truthRows: null,
        reason: "sql_truth_file_missing",
      };
    }

    let db: DatabaseSync | null = null;
    try {
      const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
      };
      db = new DatabaseSync(sqlitePath, { readOnly: true });
      const tableRows = db.prepare(
        "SELECT name, type, sql FROM sqlite_master WHERE name IN (?, ?, ?, ?)",
      ).all(SQL_TRUTH_AUTHORITY_TABLE, SQL_TRUTH_MIGRATION_TABLE, "memory_truth", "memory_truth_fts") as Array<{
        name: string;
        type: string;
        sql?: string | null;
      }>;
      const objects = new Map(tableRows.map((row) => [row.name, row]));
      const truthObject = objects.get("memory_truth");
      const ftsObject = objects.get("memory_truth_fts");
      const hasTruth = truthObject?.type === "table";
      const hasFts = ftsObject?.type === "table" &&
        /^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*\bUSING\s+fts5\s*\(/i.test(String(ftsObject.sql || ""));
      if (!hasTruth || !hasFts) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows: null,
          reason: "authority_core_schema_missing",
        };
      }

      const truthColumns = db.prepare("PRAGMA table_info(memory_truth)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value?: string | null;
        pk: number;
      }>;
      const expectedTruthTypes = ["TEXT", "TEXT", "TEXT", "TEXT", "REAL", "REAL", "TEXT", "TEXT", "REAL"];
      const truthContractInvalid =
        truthColumns.length !== REQUIRED_TRUTH_COLUMNS.length ||
        REQUIRED_TRUTH_COLUMNS.some((column, index) => {
          const actual = truthColumns[index];
          if (!actual || actual.name !== column || actual.type.toUpperCase() !== expectedTruthTypes[index]) return true;
          if (index === 0) return actual.pk !== 1;
          return actual.notnull !== 1 || actual.pk !== 0;
        });
      if (truthContractInvalid) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows: null,
          reason: "authority_truth_contract_incompatible",
        };
      }

      const ftsColumns = (db.prepare("PRAGMA table_info(memory_truth_fts)").all() as Array<{ name: string }>)
        .map((row) => row.name);
      if (
        ftsColumns.length !== REQUIRED_FTS_COLUMNS.length ||
        REQUIRED_FTS_COLUMNS.some((column, index) => ftsColumns[index] !== column) ||
        normalizeSchemaSql(String(ftsObject?.sql || "")) !== normalizeSchemaSql(FTS_TABLE_SQL)
      ) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows: null,
          reason: "authority_fts_schema_incompatible",
        };
      }

      const truthRows = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
      const authorityObject = objects.get(SQL_TRUTH_AUTHORITY_TABLE);
      if (!authorityObject) {
        return {
          status: truthRows > 0 ? "legacy" : "untrusted",
          schemaVersion: null,
          truthRows,
          reason: truthRows > 0
            ? "legacy_authority_requires_marker_upgrade"
            : "authority_marker_missing",
        };
      }
      if (authorityObject.type !== "table") {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows,
          reason: "authority_marker_schema_incompatible",
        };
      }
      const authorityColumns = new Set(
        (db.prepare(`PRAGMA table_info(${SQL_TRUTH_AUTHORITY_TABLE})`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (REQUIRED_AUTHORITY_COLUMNS.some((column) => !authorityColumns.has(column))) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows,
          reason: "authority_marker_schema_incompatible",
        };
      }
      const migrationObject = objects.get(SQL_TRUTH_MIGRATION_TABLE);
      if (migrationObject?.type !== "table") {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows,
          reason: "authority_migration_receipt_schema_missing",
        };
      }
      const migrationColumns = new Set(
        (db.prepare(`PRAGMA table_info(${SQL_TRUTH_MIGRATION_TABLE})`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (REQUIRED_MIGRATION_COLUMNS.some((column) => !migrationColumns.has(column))) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows,
          reason: "authority_migration_receipt_schema_incompatible",
        };
      }

      const schemaFingerprint = actualSchemaFingerprint(db);
      if (schemaFingerprint !== SQL_TRUTH_SCHEMA_FINGERPRINT) {
        return {
          status: "untrusted",
          schemaVersion: null,
          truthRows,
          reason: "authority_schema_fingerprint_mismatch",
        };
      }

      const marker = db.prepare(
        `SELECT authority_id, schema_version, origin, migration_id, backup_sha256, schema_fingerprint
         FROM ${SQL_TRUTH_AUTHORITY_TABLE} WHERE singleton = 1`,
      ).get() as {
        authority_id?: string;
        schema_version?: number;
        origin?: string;
        migration_id?: string | null;
        backup_sha256?: string | null;
        schema_fingerprint?: string | null;
      } | undefined;
      const schemaVersion = Number(marker?.schema_version || 0);
      if (marker?.authority_id !== SQL_TRUTH_AUTHORITY_ID || schemaVersion !== SQL_TRUTH_AUTHORITY_SCHEMA_VERSION) {
        return {
          status: "untrusted",
          schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
          truthRows,
          reason: "authority_marker_invalid",
        };
      }
      if (marker.origin !== "fresh" && marker.origin !== "legacy-upgrade") {
        return {
          status: "untrusted",
          schemaVersion,
          truthRows,
          reason: "authority_marker_origin_invalid",
        };
      }
      if (marker.schema_fingerprint !== SQL_TRUTH_SCHEMA_FINGERPRINT) {
        return {
          status: "untrusted",
          schemaVersion,
          truthRows,
          reason: "authority_marker_schema_fingerprint_invalid",
        };
      }
      if (marker.origin === "legacy-upgrade") {
        if (!marker.migration_id || !/^[a-f0-9-]{16,}$/i.test(marker.migration_id) || !/^[a-f0-9]{64}$/i.test(marker.backup_sha256 || "")) {
          return {
            status: "untrusted",
            schemaVersion,
            truthRows,
            reason: "authority_migration_receipt_invalid",
          };
        }
        const receipt = db.prepare(
          `SELECT backup_sha256 FROM ${SQL_TRUTH_MIGRATION_TABLE} WHERE migration_id = ?`,
        ).get(marker.migration_id) as { backup_sha256?: string } | undefined;
        if (receipt?.backup_sha256 !== marker.backup_sha256) {
          return {
            status: "untrusted",
            schemaVersion,
            truthRows,
            reason: "authority_migration_receipt_mismatch",
          };
        }
      } else if (marker.migration_id || marker.backup_sha256) {
        return {
          status: "untrusted",
          schemaVersion,
          truthRows,
          reason: "authority_fresh_marker_has_migration_data",
        };
      }
      return {
        status: "valid",
        schemaVersion,
        truthRows,
        reason: "authority_marker_valid",
      };
    } catch {
      return {
        status: "unreadable",
        schemaVersion: null,
        truthRows: null,
        reason: "authority_readonly_probe_failed",
      };
    } finally {
      try { db?.close?.(); } catch {}
    }
  }

  open(options: SqlTruthOpenOptions = {}): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    const inspection = SqlTruthStore.inspectAuthority(this.sqlitePath);
    if (inspection.status === "missing" && options.allowCreate === false) {
      throw new Error("CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: SQL truth authority is missing");
    }
    if (inspection.status === "unreadable") {
      throw new Error("CLAWLORE_SQL_TRUTH_UNAVAILABLE: SQL truth authority cannot be opened read-only");
    }
    if (inspection.status === "untrusted") {
      throw new Error(`CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: ${inspection.reason}`);
    }
    if (inspection.status === "legacy") {
      throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED: legacy SQL truth requires a backup-backed authority migration receipt");
    }
    const creating = inspection.status === "missing";
    const directory = dirname(this.sqlitePath);
    ensurePrivateDirectory(directory);
    if (!creating) enforcePrivatePath(this.sqlitePath, { kind: "file" });
    try {
      this.db = new DatabaseSync(this.sqlitePath);
      this.enforcePrivateFiles();
      runSql(this.db, "PRAGMA busy_timeout = 10000");
      runSql(this.db, "PRAGMA journal_mode = WAL");
      runSql(this.db, "PRAGMA synchronous = NORMAL");
      this.privacyEstablished = true;
      this.ensureSchema(creating ? { origin: "fresh" } : undefined);
      this.enforcePrivateFiles();
    } catch (error) {
      try { this.db?.close?.(); } catch {}
      this.db = null;
      this.privacyEstablished = false;
      if (creating) {
        for (const path of [this.sqlitePath, `${this.sqlitePath}-wal`, `${this.sqlitePath}-shm`]) {
          try { rmSync(path, { force: true }); } catch {}
        }
      }
      throw error;
    }
  }

  static upgradeLegacyAuthority(
    sqlitePath: string,
    evidence: SqlTruthLegacyUpgradeEvidence,
    faultInjector?: (point: string) => void,
  ): SqlTruthAuthorityInspection {
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    if (inspection.status !== "legacy" || inspection.truthRows !== evidence.sourceTruthRows) {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source is not the inspected legacy authority");
    }
    if (
      !/^[a-f0-9-]{16,}$/i.test(evidence.migrationId) ||
      !/^[a-f0-9]{64}$/i.test(evidence.backupSha256) ||
      !/^[a-f0-9]{64}$/i.test(evidence.sourceSnapshotSha256)
    ) {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup evidence is invalid");
    }
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    const store = new SqlTruthStore(sqlitePath, faultInjector);
    const directory = dirname(sqlitePath);
    ensurePrivateDirectory(directory);
    enforcePrivatePath(sqlitePath, { kind: "file" });
    try {
      store.db = new DatabaseSync(sqlitePath);
      store.enforcePrivateFiles();
      runSql(store.db, "PRAGMA busy_timeout = 10000");
      runSql(store.db, "PRAGMA journal_mode = WAL");
      runSql(store.db, "PRAGMA synchronous = FULL");
      store.privacyEstablished = true;
      store.enforcePrivateFiles();
      store.skipWindowsPrivacyCheckInTransaction = true;
      runSql(store.db, "BEGIN IMMEDIATE");
      try {
        const lockedSnapshot = legacySnapshotDigestFromDb(store.db);
        if (lockedSnapshot !== evidence.sourceSnapshotSha256) {
          throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source changed after backup snapshot");
        }
        store.injectFault("migration_after_source_snapshot_lock");
        store.canonicalizeLegacySchema();
        store.injectFault("migration_after_schema_canonicalization");
        store.ensureSchema({ origin: "legacy-upgrade", evidence });
        store.enforcePrivateFiles();
        store.injectFault("migration_before_commit");
        runSql(store.db, "COMMIT");
        store.injectFault("migration_after_commit");
      } catch (error) {
        try { runSql(store.db, "ROLLBACK"); } catch {}
        throw error;
      } finally {
        store.skipWindowsPrivacyCheckInTransaction = false;
      }
    } finally {
      store.close();
    }
    const upgraded = SqlTruthStore.inspectAuthority(sqlitePath);
    if (upgraded.status !== "valid" || upgraded.truthRows !== evidence.sourceTruthRows) {
      throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_FAILED: post-upgrade authority validation failed");
    }
    return upgraded;
  }

  static legacySnapshotDigest(sqlitePath: string): string {
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    if (inspection.status !== "legacy") {
      throw new Error(`CLAWLORE_SQL_TRUTH_LEGACY_SNAPSHOT_REFUSED: source_authority_${inspection.status}`);
    }
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
    };
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      return legacySnapshotDigestFromDb(db);
    } finally {
      db.close();
    }
  }

  close(): void {
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
      this.privacyEstablished = false;
    }
  }

  upsert(entry: MemoryEntry): void {
    this.withTransaction(() => this.upsertStatements(entry));
  }

  upsertWithVectorIntent(entry: MemoryEntry, operation: string): void {
    this.withTransaction(() => {
      this.upsertStatements(entry);
      this.recordVectorRepairDebtStatements({
        memoryId: entry.id,
        action: "upsert",
        operation,
        error: "pending_vector_companion_sync",
      });
    });
  }

  private upsertStatements(entry: MemoryEntry): void {
    const db = this.requireDb();
    const metadata = entry.metadata || "{}";
    const metadataText = metadataSearchText(metadata);
    db.prepare(
      `
      INSERT INTO memory_truth (
        id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        category = excluded.category,
        scope = excluded.scope,
        importance = excluded.importance,
        timestamp = excluded.timestamp,
        metadata = excluded.metadata,
        metadata_text = excluded.metadata_text,
        updated_at = excluded.updated_at
      `,
    ).run(
      entry.id,
      entry.text || "",
      entry.category || "other",
      entry.scope || "global",
      Number(entry.importance) || 0,
      Number(entry.timestamp) || Date.now(),
      metadata,
      metadataText,
      Date.now(),
    );
    this.injectFault("truth_after_upsert");
    this.replaceFts(entry.id, entry.text || "", metadataText);
  }

  delete(id: string): void {
    this.withTransaction(() => this.deleteStatements(id));
  }

  deleteWithVectorIntent(id: string, operation: string): void {
    this.withTransaction(() => {
      this.deleteStatements(id);
      this.recordVectorRepairDebtStatements({
        memoryId: id,
        action: "delete",
        operation,
        error: "pending_vector_companion_sync",
      });
    });
  }

  private deleteStatements(id: string): void {
    const db = this.requireDb();
    this.injectFault("fts_before_delete");
    db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memory_truth WHERE id = ?").run(id);
  }

  /**
   * Persist a temporal revision and invalidate its predecessor in one SQL
   * transaction. SQL truth is authoritative; either both rows commit or
   * neither does.
   */
  supersedeAtomically(oldEntry: MemoryEntry, newEntry: MemoryEntry, factKey: string): void {
    const db = this.requireDb();
    this.withTransaction(() => {
      const current = db.prepare("SELECT id, scope FROM memory_truth WHERE id = ? LIMIT 1")
        .get(oldEntry.id) as { id: string; scope: string } | undefined;
      if (!current || current.scope !== oldEntry.scope) {
        throw new Error(`Supersede predecessor ${oldEntry.id} no longer exists in scope ${oldEntry.scope}`);
      }
      if (oldEntry.id === newEntry.id) {
        throw new Error("Supersede revision must use a new memory id");
      }

      this.upsertStatements(oldEntry);
      this.upsertStatements(newEntry);
      this.recordVectorRepairDebtStatements({
        memoryId: oldEntry.id,
        action: "upsert",
        operation: "supersede-old",
        error: "pending_vector_companion_sync",
      });
      this.recordVectorRepairDebtStatements({
        memoryId: newEntry.id,
        action: "upsert",
        operation: "supersede-new",
        error: "pending_vector_companion_sync",
      });

      const active = db.prepare(
        `
        SELECT id
        FROM memory_truth
        WHERE scope = ?
          AND json_extract(metadata, '$.fact_key') = ?
          AND COALESCE(json_extract(metadata, '$.invalidated_at'), 0) = 0
          AND COALESCE(json_extract(metadata, '$.superseded_by'), '') = ''
          AND (
            json_extract(metadata, '$.valid_to') IS NULL
            OR CAST(json_extract(metadata, '$.valid_to') AS REAL) > ?
          )
        `,
      ).all(oldEntry.scope, factKey, Date.now()) as Array<{ id: string }>;
      if (active.length !== 1 || active[0]?.id !== newEntry.id) {
        throw new Error(
          `Atomic supersede invariant failed for ${oldEntry.scope}/${factKey}: expected only ${newEntry.id}, found ${active.map((row) => row.id).join(",") || "none"}`,
        );
      }

    });
  }

  getById(id: string, scopeFilter?: string[]): MemoryEntry | null {
    const db = this.requireDb();
    const scope = this.scopeClause("memory_truth", scopeFilter);
    const row = db.prepare(
      `
      SELECT *
      FROM memory_truth
      WHERE id = ? AND ${scope.sql}
      LIMIT 1
      `,
    ).get(id, ...scope.params) as SqlRow | undefined;
    return row ? toMemoryEntry(row) : null;
  }

  getByIds(ids: string[], scopeFilter?: string[]): MemoryEntry[] {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const db = this.requireDb();
    const scope = this.scopeClause("memory_truth", scopeFilter);
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db.prepare(
      `
      SELECT *
      FROM memory_truth
      WHERE id IN (${placeholders}) AND ${scope.sql}
      `,
    ).all(...uniqueIds, ...scope.params) as SqlRow[];
    return rows.map(toMemoryEntry);
  }

  recordVectorRepairDebt(input: {
    memoryId: string;
    action: "upsert" | "delete";
    operation: string;
    error: string;
  }): void {
    this.withTransaction(() => this.recordVectorRepairDebtStatements(input));
  }

  private recordVectorRepairDebtStatements(input: {
    memoryId: string;
    action: "upsert" | "delete";
    operation: string;
    error: string;
  }): void {
    const now = Date.now();
    this.injectFault("vector_intent_before_insert");
    this.requireDb().prepare(
      `
      INSERT INTO vector_companion_repair_outbox (
        memory_id, action, operation, last_error, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        action = excluded.action,
        operation = excluded.operation,
        last_error = excluded.last_error,
        attempts = vector_companion_repair_outbox.attempts + 1,
        updated_at = excluded.updated_at
      `,
    ).run(input.memoryId, input.action, input.operation, input.error, now, now);
  }

  clearVectorRepairDebt(memoryId: string): void {
    this.withTransaction(() => {
      this.requireDb()
        .prepare("DELETE FROM vector_companion_repair_outbox WHERE memory_id = ?")
        .run(memoryId);
    });
  }

  vectorRepairDebtReport(): VectorRepairDebtReport {
    const row = this.requireDb().prepare(
      `
      SELECT
        COUNT(*) AS pending,
        MIN(created_at) AS oldest_created_at,
        MAX(updated_at) AS latest_updated_at
      FROM vector_companion_repair_outbox
      `,
    ).get() as {
      pending: number;
      oldest_created_at: number | null;
      latest_updated_at: number | null;
    };
    return {
      pending: Number(row?.pending || 0),
      oldestCreatedAt: row?.oldest_created_at == null ? null : Number(row.oldest_created_at),
      latestUpdatedAt: row?.latest_updated_at == null ? null : Number(row.latest_updated_at),
    };
  }

  listVectorRepairDebt(limit = 100_000): VectorRepairDebtEntry[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 1_000_000));
    const rows = this.requireDb().prepare(
      `
      SELECT memory_id, action, operation, attempts, created_at, updated_at
      FROM vector_companion_repair_outbox
      ORDER BY updated_at ASC, memory_id ASC
      LIMIT ?
      `,
    ).all(safeLimit) as Array<{
      memory_id: string;
      action: "upsert" | "delete";
      operation: string;
      attempts: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      action: row.action,
      operation: row.operation,
      attempts: Number(row.attempts),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  findByPrefix(prefix: string, scopeFilter?: string[]): MemoryEntry[] {
    const db = this.requireDb();
    const scope = this.scopeClause("memory_truth", scopeFilter);
    const rows = db.prepare(
      `
      SELECT *
      FROM memory_truth
      WHERE id LIKE ? AND ${scope.sql}
      ORDER BY timestamp DESC
      LIMIT 50
      `,
    ).all(`${prefix}%`, ...scope.params) as SqlRow[];
    return rows.map(toMemoryEntry);
  }

  list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): MemoryEntry[] {
    const db = this.requireDb();
    const scope = this.scopeClause("m", scopeFilter);
    const clauses = [scope.sql];
    const params = [...scope.params];
    if (category) {
      clauses.push("m.category = ?");
      params.push(category);
    }
    const safeLimit = clampInt(limit, 1, MAX_LIST_LIMIT);
    const safeOffset = clampInt(offset, 0, 1000000);
    const rows = db.prepare(
      `
      SELECT m.*
      FROM memory_truth m
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
      `,
    ).all(...params, safeLimit, safeOffset) as SqlRow[];
    return rows.map(toMemoryEntry);
  }

  stats(scopeFilter?: string[]): SqlTruthStats {
    const db = this.requireDb();
    const scope = this.scopeClause("m", scopeFilter);
    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM memory_truth m WHERE ${scope.sql}`,
    ).get(...scope.params) as { count: number };
    const scopeRows = db.prepare(
      `
      SELECT COALESCE(m.scope, 'global') AS scope, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY COALESCE(m.scope, 'global')
      `,
    ).all(...scope.params) as Array<{ scope: string; count: number }>;
    const categoryRows = db.prepare(
      `
      SELECT m.category AS category, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY m.category
      `,
    ).all(...scope.params) as Array<{ category: string; count: number }>;

    return {
      totalCount: Number(total?.count || 0),
      scopeCounts: Object.fromEntries(scopeRows.map((row) => [row.scope, Number(row.count)])),
      categoryCounts: Object.fromEntries(categoryRows.map((row) => [row.category, Number(row.count)])),
    };
  }

  bulkDelete(scopeFilter: string[], beforeTimestamp?: number): string[] {
    const db = this.requireDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scopeFilter.length > 0) {
      const scope = this.scopeClause("m", scopeFilter);
      clauses.push(scope.sql);
      params.push(...scope.params);
    }
    if (beforeTimestamp) {
      clauses.push("m.timestamp < ?");
      params.push(beforeTimestamp);
    }
    if (clauses.length === 0) {
      throw new Error("SQL truth bulk delete requires at least scope or timestamp filter");
    }
    const rows = db.prepare(
      `SELECT m.id FROM memory_truth m WHERE ${clauses.join(" AND ")}`,
    ).all(...params) as Array<{ id: string }>;
    this.withTransaction(() => {
      for (const row of rows) {
        this.deleteStatements(row.id);
        this.recordVectorRepairDebtStatements({
          memoryId: row.id,
          action: "delete",
          operation: "bulk-delete",
          error: "pending_vector_companion_sync",
        });
      }
    });
    return rows.map((row) => row.id);
  }

  reconcile(
    entries: MemoryEntry[],
    options: { deleteMissing?: boolean } = {},
  ): { upserted: number; deleted: number } {
    const db = this.requireDb();
    let upserted = 0;
    let deleted = 0;
    const deleteMissing = options.deleteMissing === true;
    return this.withTransaction(() => {
      const wanted = new Set(entries.map((entry) => entry.id).filter(Boolean));
      for (const entry of entries) {
        if (!entry.id) continue;
        this.upsertStatements(entry);
        upserted++;
      }
      if (deleteMissing) {
        const rows = db.prepare("SELECT id FROM memory_truth").all() as Array<{ id: string }>;
        for (const row of rows) {
          if (wanted.has(row.id)) continue;
          this.deleteStatements(row.id);
          deleted++;
        }
      }
      return { upserted, deleted };
    });
  }

  search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): MemorySearchResult[] {
    const db = this.requireDb();
    const trimmed = query.trim();
    if (!trimmed) return [];

    const safeLimit = clampInt(limit, 1, 20);
    const candidatePool = Math.min(Math.max(safeLimit * 4, safeLimit), 120);
    const tokens = queryTokens(trimmed);
    const ftsQuery = buildFtsQuery(tokens);
    const rowsById = new Map<string, SqlRow>();
    const rawBm25 = new Map<string, number>();
    const scope = this.scopeClause("m", scopeFilter);

    if (ftsQuery) {
      const rows = db.prepare(
        `
        SELECT m.*, bm25(memory_truth_fts) AS raw_bm25
        FROM memory_truth_fts
        JOIN memory_truth m ON m.id = memory_truth_fts.memory_id
        WHERE memory_truth_fts MATCH ? AND ${scope.sql}
        ORDER BY bm25(memory_truth_fts) ASC, m.timestamp DESC
        LIMIT ?
        `,
      ).all(ftsQuery, ...scope.params, candidatePool) as SqlRow[];
      for (const row of rows) {
        rowsById.set(row.id, row);
        if (Number.isFinite(Number(row.raw_bm25))) {
          rawBm25.set(row.id, Number(row.raw_bm25));
        }
      }
    }

    for (const term of tokens.slice(0, 6)) {
      const likeScope = this.scopeClause("m", scopeFilter);
      const rows = db.prepare(
        `
        SELECT m.*, NULL AS raw_bm25
        FROM memory_truth m
        WHERE (m.text LIKE ? OR m.metadata_text LIKE ?) AND ${likeScope.sql}
        ORDER BY m.timestamp DESC
        LIMIT ?
        `,
      ).all(`%${term}%`, `%${term}%`, ...likeScope.params, candidatePool) as SqlRow[];
      for (const row of rows) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
    }

    const bm25Scores = normalizeBm25(rawBm25);
    const results: MemorySearchResult[] = [];
    for (const row of rowsById.values()) {
      const entry = toMemoryEntry(row);
      if (options?.excludeInactive && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
        continue;
      }
      const lexical = scoreLexicalHit(trimmed, row.text || "", row.metadata_text || "");
      const bm25 = bm25Scores.get(row.id) ?? 0;
      const score = Math.max(lexical, bm25 * 0.96);
      if (score <= 0) continue;
      results.push({ entry, score });
    }

    return results
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, safeLimit);
  }

  count(): number {
    return Number(this.requireDb().prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
  }

  private canonicalizeLegacySchema(): void {
    const db = this.requireDb();
    runSql(db, `
      DROP TRIGGER IF EXISTS memory_truth_single_active_fact_insert;
      DROP TRIGGER IF EXISTS memory_truth_single_active_fact_update;
      DROP INDEX IF EXISTS idx_memory_truth_scope_timestamp;
      DROP INDEX IF EXISTS idx_memory_truth_category_timestamp;
      DROP INDEX IF EXISTS idx_vector_companion_repair_updated_at;
      DROP TABLE IF EXISTS vector_companion_repair_outbox;
      DROP TABLE IF EXISTS ${SQL_TRUTH_AUTHORITY_TABLE};
      DROP TABLE IF EXISTS ${SQL_TRUTH_MIGRATION_TABLE};
      DROP TABLE memory_truth_fts;
      ALTER TABLE memory_truth RENAME TO memory_truth_legacy_upgrade_source;
      ${TRUTH_TABLE_SQL};
      INSERT INTO memory_truth (
        id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
      )
      SELECT id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
      FROM memory_truth_legacy_upgrade_source;
      DROP TABLE memory_truth_legacy_upgrade_source;
      ${FTS_TABLE_SQL};
    `);
  }

  private ensureSchema(marker?: {
    origin: "fresh" | "legacy-upgrade";
    evidence?: SqlTruthLegacyUpgradeEvidence;
  }): void {
    const db = this.requireDb();
    this.withTransaction(() => {
      runSql(db, `${EXPECTED_SCHEMA_OBJECTS.map(([, , sql]) => sql).join(";\n")};`);
      this.injectFault("schema_after_ddl");
      this.reconcileFts();
      this.injectFault("schema_after_fts_reconcile");
      if (!marker) return;

      const now = marker.evidence?.completedAt ?? Date.now();
      if (marker.origin === "legacy-upgrade") {
        const evidence = marker.evidence;
        if (!evidence) {
          throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: migration evidence missing");
        }
        db.prepare(
          `INSERT INTO ${SQL_TRUTH_MIGRATION_TABLE} (
             migration_id, source_truth_rows, backup_sha256, source_snapshot_sha256, completed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          evidence.migrationId,
          evidence.sourceTruthRows,
          evidence.backupSha256,
          evidence.sourceSnapshotSha256,
          evidence.completedAt,
        );
      }
      this.injectFault("schema_before_authority_marker");
      db.prepare(
        `
        INSERT INTO ${SQL_TRUTH_AUTHORITY_TABLE} (
          singleton, authority_id, schema_version, origin, migration_id,
          backup_sha256, schema_fingerprint, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        SQL_TRUTH_AUTHORITY_ID,
        SQL_TRUTH_AUTHORITY_SCHEMA_VERSION,
        marker.origin,
        marker.evidence?.migrationId ?? null,
        marker.evidence?.backupSha256 ?? null,
        SQL_TRUTH_SCHEMA_FINGERPRINT,
        now,
        now,
      );
      this.injectFault("schema_after_authority_marker");
    });
  }

  ftsIntegrityReport(): SqlTruthFtsReport {
    const db = this.requireDb();
    const counts = db.prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM memory_truth) AS truth_rows,
        (SELECT COUNT(*) FROM memory_truth_fts) AS fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth_fts AS f
          LEFT JOIN memory_truth AS m ON m.id = f.memory_id
          WHERE m.id IS NULL
        ) AS stale_fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth AS m
          LEFT JOIN memory_truth_fts AS f ON f.memory_id = m.id
          WHERE f.memory_id IS NULL
        ) AS missing_fts_rows,
        (
          SELECT COALESCE(SUM(extra), 0)
          FROM (
            SELECT COUNT(*) - 1 AS extra
            FROM memory_truth_fts
            GROUP BY memory_id
            HAVING COUNT(*) > 1
          )
        ) AS duplicate_fts_extra_rows
      `,
    ).get() as {
      truth_rows: number;
      fts_rows: number;
      stale_fts_rows: number;
      missing_fts_rows: number;
      duplicate_fts_extra_rows: number;
    };
    const report = {
      truthRows: Number(counts.truth_rows || 0),
      ftsRows: Number(counts.fts_rows || 0),
      staleFtsRows: Number(counts.stale_fts_rows || 0),
      missingFtsRows: Number(counts.missing_fts_rows || 0),
      duplicateFtsExtraRows: Number(counts.duplicate_fts_extra_rows || 0),
      healthy: false,
    };
    report.healthy =
      report.truthRows === report.ftsRows &&
      report.staleFtsRows === 0 &&
      report.missingFtsRows === 0 &&
      report.duplicateFtsExtraRows === 0;
    return report;
  }

  private reconcileFts(): void {
    const db = this.requireDb();
    if (this.ftsIntegrityReport().healthy) return;
    runSql(db, "DELETE FROM memory_truth_fts");
    runSql(db, "INSERT INTO memory_truth_fts(memory_id, text, metadata_text) SELECT id, text, metadata_text FROM memory_truth");
  }

  private replaceFts(id: string, text: string, metadataText: string): void {
    const db = this.requireDb();
    db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
    this.injectFault("fts_before_insert");
    db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, ?)").run(id, text, metadataText);
  }

  private injectFault(point: string): void {
    this.faultInjector?.(point);
  }

  private withTransaction<T>(operation: () => T): T {
    const db = this.requireDb();
    if (!this.privacyEstablished) {
      throw new Error("CLAWLORE_SQL_TRUTH_PERMISSION_ENFORCEMENT_FAILED: storage privacy is not established");
    }
    // Windows ACL enforcement invokes external system tools. Verify before
    // taking the SQLite write lock; the protected parent DACL makes newly
    // created WAL/SHM files inherit the owner-only policy.
    if (process.platform === "win32" && !this.skipWindowsPrivacyCheckInTransaction) {
      this.enforcePrivateFiles();
    }
    const savepoint = `clawlore_truth_${++this.savepointSequence}`;
    runSql(db, `SAVEPOINT ${savepoint}`);
    try {
      const result = operation();
      // File privacy is part of the durable write contract. Validate it before
      // releasing the savepoint so an enforcement failure rolls SQL/FTS/outbox
      // state back instead of reporting a false API failure after commit.
      if (process.platform !== "win32") {
        this.enforcePrivateFiles();
      }
      runSql(db, `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      try { runSql(db, `ROLLBACK TO SAVEPOINT ${savepoint}`); } catch {}
      try { runSql(db, `RELEASE SAVEPOINT ${savepoint}`); } catch {}
      throw err;
    }
  }

  private enforcePrivateFiles(): void {
    this.injectFault("permissions_before_enforce");
    for (const path of [this.sqlitePath, `${this.sqlitePath}-wal`, `${this.sqlitePath}-shm`]) {
      try {
        if (!existsSync(path)) continue;
        enforcePrivatePath(path, { kind: "file" });
      } catch (err) {
        const name = path === this.sqlitePath
          ? "database"
          : path.endsWith("-wal")
            ? "wal"
            : "shm";
        throw new Error(
          `CLAWLORE_SQL_TRUTH_PERMISSION_ENFORCEMENT_FAILED: ${name} is not private`,
          { cause: err },
        );
      }
    }
  }

  private scopeClause(alias: string, scopeFilter?: string[]): ScopeClause {
    if (scopeFilter === undefined) {
      return { sql: "1 = 1", params: [] };
    }
    if (scopeFilter.length === 0) return { sql: "0 = 1", params: [] };
    const scopes = scopeFilter.filter(Boolean);
    if (scopes.length === 0) {
      return { sql: "0 = 1", params: [] };
    }
    const placeholders = scopes.map(() => "?").join(", ");
    return {
      sql: `(${alias}.scope IN (${placeholders}) OR ${alias}.scope IS NULL)`,
      params: scopes,
    };
  }

  /**
   * Get the underlying database connection for Experience Kernel operations.
   * @internal
   */
  getDb(): DatabaseSync {
    return this.requireDb();
  }

  verifyFilePrivacy(): void {
    enforcePrivatePath(dirname(this.sqlitePath), { kind: "directory" });
    this.enforcePrivateFiles();
    this.privacyEstablished = true;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error(`SQL truth store is not open: ${join(this.sqlitePath)}`);
    }
    return this.db;
  }
}
