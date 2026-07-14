import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { TRUTH_V2_SCHEMA_SQL } from "../storage/sqlite-truth-v2.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

const CORE_TABLES = [
  "memory_items",
  "memory_revisions",
  "memory_sources",
  "memory_acl",
  "memory_relations",
  "memory_events",
  "projection_outbox",
] as const;

const REQUIRED_FOREIGN_KEYS = {
  memory_items: 2,
  memory_revisions: 1,
  memory_sources: 1,
  memory_acl: 1,
  memory_relations: 2,
  memory_events: 2,
  projection_outbox: 2,
} as const;

export interface TruthSchemaHardeningPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-truth-schema-hardening";
  status: "ready" | "already_hardened" | "blocked";
  currentSchemaVersion: number;
  targetSchemaVersion: 3;
  tableCounts: Record<(typeof CORE_TABLES)[number], number>;
  foreignKeyCounts: Record<keyof typeof REQUIRED_FOREIGN_KEYS, number>;
  blockers: string[];
  historicalReferences: {
    eventItemsWithoutCurrentRow: number;
    outboxItemsWithoutCurrentRow: number;
    eventRevisionsWithoutCurrentRow: number;
    outboxRevisionsWithoutCurrentRow: number;
  };
  planDigest: string;
  authorizesMutation: false;
}

export interface TruthSchemaHardeningReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-truth-schema-hardening-apply";
  status: "applied" | "already_hardened";
  planDigest: string;
  appliedAt: string;
  targetSchemaVersion: 3;
  identityRows: number;
  tableCounts: TruthSchemaHardeningPlanV1["tableCounts"];
  foreignKeyCounts: TruthSchemaHardeningPlanV1["foreignKeyCounts"];
  foreignKeyViolations: 0;
  integrity: "ok";
}

function open(path: string, readOnly = false): DatabaseSync {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=10000");
  return db;
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Number(db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name).count) === 1;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inspect(db: DatabaseSync): Omit<TruthSchemaHardeningPlanV1, "planDigest"> {
  const missing = CORE_TABLES.filter((table) => !tableExists(db, table));
  const blockers = missing.map((table) => `missing_table:${table}`);
  const tableCounts = Object.fromEntries(CORE_TABLES.map((table) => [
    table,
    tableExists(db, table) ? scalar(db, `SELECT COUNT(*) FROM ${table}`) : 0,
  ])) as TruthSchemaHardeningPlanV1["tableCounts"];
  const currentSchemaVersion = tableExists(db, "clawlore_schema")
    ? scalar(db, "SELECT COALESCE(MAX(version),0) FROM clawlore_schema")
    : 0;
  const foreignKeyCounts = Object.fromEntries(Object.keys(REQUIRED_FOREIGN_KEYS).map((table) => [
    table,
    tableExists(db, table) ? (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown[]).length : 0,
  ])) as TruthSchemaHardeningPlanV1["foreignKeyCounts"];

  if (missing.length === 0) {
    const orphanChecks = [
      ["item_current_revision_missing", `SELECT COUNT(*) FROM memory_items i LEFT JOIN memory_revisions r
        ON r.revision_id=i.current_revision_id AND r.item_id=i.item_id WHERE r.revision_id IS NULL`],
      ["revision_item_missing", `SELECT COUNT(*) FROM memory_revisions r LEFT JOIN memory_items i
        ON i.item_id=r.item_id WHERE i.item_id IS NULL`],
      ["source_revision_missing", `SELECT COUNT(*) FROM memory_sources s LEFT JOIN memory_revisions r
        ON r.revision_id=s.revision_id WHERE r.revision_id IS NULL`],
      ["acl_item_missing", `SELECT COUNT(*) FROM memory_acl a LEFT JOIN memory_items i
        ON i.item_id=a.item_id WHERE i.item_id IS NULL`],
      ["relation_from_revision_missing", `SELECT COUNT(*) FROM memory_relations x LEFT JOIN memory_revisions r
        ON r.revision_id=x.from_revision_id WHERE r.revision_id IS NULL`],
      ["relation_to_revision_missing", `SELECT COUNT(*) FROM memory_relations x LEFT JOIN memory_revisions r
        ON r.revision_id=x.to_revision_id WHERE r.revision_id IS NULL`],
    ] as const;
    for (const [code, sql] of orphanChecks) {
      const count = scalar(db, sql);
      if (count > 0) blockers.push(`${code}:${count}`);
    }
  }

  const historicalReferences = missing.length === 0 ? {
    eventItemsWithoutCurrentRow: scalar(db, `SELECT COUNT(*) FROM memory_events e LEFT JOIN memory_items i
      ON i.item_id=e.item_id WHERE i.item_id IS NULL`),
    outboxItemsWithoutCurrentRow: scalar(db, `SELECT COUNT(*) FROM projection_outbox o LEFT JOIN memory_items i
      ON i.item_id=o.item_id WHERE i.item_id IS NULL`),
    eventRevisionsWithoutCurrentRow: scalar(db, `SELECT COUNT(*) FROM memory_events e LEFT JOIN memory_revisions r
      ON r.revision_id=e.revision_id WHERE e.revision_id IS NOT NULL AND r.revision_id IS NULL`),
    outboxRevisionsWithoutCurrentRow: scalar(db, `SELECT COUNT(*) FROM projection_outbox o LEFT JOIN memory_revisions r
      ON r.revision_id=o.revision_id WHERE o.revision_id IS NOT NULL AND r.revision_id IS NULL`),
  } : {
    eventItemsWithoutCurrentRow: 0,
    outboxItemsWithoutCurrentRow: 0,
    eventRevisionsWithoutCurrentRow: 0,
    outboxRevisionsWithoutCurrentRow: 0,
  };
  const hardened = currentSchemaVersion >= 3
    && tableExists(db, "memory_item_identities")
    && Object.entries(REQUIRED_FOREIGN_KEYS).every(([table, count]) => foreignKeyCounts[table as keyof typeof REQUIRED_FOREIGN_KEYS] >= count);
  return {
    schemaVersion: 1,
    phase: "clawlore-truth-schema-hardening",
    status: blockers.length > 0 ? "blocked" : hardened ? "already_hardened" : "ready",
    currentSchemaVersion,
    targetSchemaVersion: 3,
    tableCounts,
    foreignKeyCounts,
    blockers,
    historicalReferences,
    authorizesMutation: false,
  };
}

export function previewTruthSchemaHardeningV1(path: string): TruthSchemaHardeningPlanV1 {
  const db = open(path, true);
  try {
    const value = inspect(db);
    return { ...value, planDigest: digest(value) };
  } finally {
    db.close();
  }
}

function renameLegacyTables(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_memory_access;
    DROP INDEX IF EXISTS idx_memory_conversation;
    DROP INDEX IF EXISTS idx_memory_project;
    DROP INDEX IF EXISTS idx_outbox_pending;
    DROP TRIGGER IF EXISTS memory_items_identity_before_insert;
    ALTER TABLE memory_items RENAME TO __h3_memory_items;
    ALTER TABLE memory_revisions RENAME TO __h3_memory_revisions;
    ALTER TABLE memory_sources RENAME TO __h3_memory_sources;
    ALTER TABLE memory_acl RENAME TO __h3_memory_acl;
    ALTER TABLE memory_relations RENAME TO __h3_memory_relations;
    ALTER TABLE memory_events RENAME TO __h3_memory_events;
    ALTER TABLE projection_outbox RENAME TO __h3_projection_outbox;
  `);
}

function copyLegacyRows(db: DatabaseSync, appliedAt: string): void {
  db.prepare(`INSERT INTO memory_item_identities(item_id,created_at,purged_at)
    SELECT item_id,MIN(created_at),NULL FROM (
      SELECT item_id,created_at FROM __h3_memory_items
      UNION ALL SELECT item_id,created_at FROM __h3_memory_events
      UNION ALL SELECT item_id,created_at FROM __h3_projection_outbox
    ) GROUP BY item_id`).run();
  db.exec(`
    INSERT INTO memory_items SELECT * FROM __h3_memory_items;
    INSERT INTO memory_revisions SELECT * FROM __h3_memory_revisions;
    INSERT INTO memory_sources SELECT * FROM __h3_memory_sources;
    INSERT INTO memory_acl SELECT * FROM __h3_memory_acl;
    INSERT INTO memory_relations SELECT * FROM __h3_memory_relations;
    INSERT INTO memory_events
      SELECT event_id,item_id,
        CASE WHEN revision_id IS NULL OR revision_id IN (SELECT revision_id FROM memory_revisions)
          THEN revision_id ELSE NULL END,
        event_type,actor,reason,created_at FROM __h3_memory_events;
    INSERT INTO projection_outbox
      SELECT outbox_id,item_id,
        CASE WHEN revision_id IS NULL OR revision_id IN (SELECT revision_id FROM memory_revisions)
          THEN revision_id ELSE NULL END,
        operation,projection,attempts,available_at,created_at,processed_at,last_error
      FROM __h3_projection_outbox;
  `);
  db.prepare("UPDATE memory_item_identities SET purged_at=? WHERE item_id NOT IN (SELECT item_id FROM memory_items)")
    .run(appliedAt);
}

function dropLegacyTables(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE __h3_memory_sources;
    DROP TABLE __h3_memory_acl;
    DROP TABLE __h3_memory_relations;
    DROP TABLE __h3_memory_events;
    DROP TABLE __h3_projection_outbox;
    DROP TABLE __h3_memory_revisions;
    DROP TABLE __h3_memory_items;
  `);
}

export function applyTruthSchemaHardeningV1(input: {
  path: string;
  expectedPlanDigest: string;
  now?: () => Date;
}): TruthSchemaHardeningReceiptV1 {
  const before = previewTruthSchemaHardeningV1(input.path);
  if (before.planDigest !== input.expectedPlanDigest) throw new Error("schema hardening plan digest is stale");
  if (before.status === "blocked") throw new Error(`schema hardening is blocked: ${before.blockers.join(",")}`);
  const appliedAt = (input.now?.() ?? new Date()).toISOString();
  if (before.status === "already_hardened") {
    const db = open(input.path, true);
    try {
      const after = inspect(db);
      return {
        schemaVersion: 1,
        phase: "clawlore-truth-schema-hardening-apply",
        status: "already_hardened",
        planDigest: before.planDigest,
        appliedAt,
        targetSchemaVersion: 3,
        identityRows: scalar(db, "SELECT COUNT(*) FROM memory_item_identities"),
        tableCounts: after.tableCounts,
        foreignKeyCounts: after.foreignKeyCounts,
        foreignKeyViolations: 0,
        integrity: "ok",
      };
    } finally {
      db.close();
    }
  }

  const db = open(input.path);
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA synchronous=FULL;");
  try {
    db.exec("BEGIN IMMEDIATE");
    renameLegacyTables(db);
    db.exec(TRUTH_V2_SCHEMA_SQL);
    copyLegacyRows(db, appliedAt);
    dropLegacyTables(db);
    const violations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    if (violations !== 0 || integrity !== "ok") {
      throw new Error(`schema hardening verification failed: integrity=${integrity} foreign_keys=${violations}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON");
  const after = inspect(db);
  const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
  const identityRows = scalar(db, "SELECT COUNT(*) FROM memory_item_identities");
  db.close();
  if (after.status !== "already_hardened" || foreignKeyViolations !== 0 || integrity !== "ok") {
    throw new Error("schema hardening independent postcheck failed");
  }
  return {
    schemaVersion: 1,
    phase: "clawlore-truth-schema-hardening-apply",
    status: "applied",
    planDigest: before.planDigest,
    appliedAt,
    targetSchemaVersion: 3,
    identityRows,
    tableCounts: after.tableCounts,
    foreignKeyCounts: after.foreignKeyCounts,
    foreignKeyViolations: 0,
    integrity: "ok",
  };
}
