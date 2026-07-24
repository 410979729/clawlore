import { createRequire } from "node:module";

import { SqliteTruthStoreV2 } from "./v2/storage/sqlite-truth-v2.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface FreshInstallV2AuthorityV1 {
  schemaVersion: 1;
  authority: "fresh-v2" | "legacy-or-migrated";
  mayActivateWithoutMigrationReceipt: boolean;
}

const PROJECTION_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_v2
    USING fts5(item_id UNINDEXED,content,category);
  CREATE TABLE IF NOT EXISTS memory_vector_projection_v2 (
    item_id TEXT PRIMARY KEY,
    legacy_id TEXT NOT NULL,
    backend TEXT NOT NULL,
    state TEXT NOT NULL,
    verified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS memory_relation_projection_v2 (
    item_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    verified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS clawlore_runtime_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    authority TEXT NOT NULL CHECK(authority IN ('fresh-v2','legacy-or-migrated')),
    created_at TEXT NOT NULL
  );
`;

function tableExists(db: DatabaseSync, name: string): boolean {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name).n) === 1;
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

/**
 * Establishes V2 authority only for a genuinely empty local store.
 *
 * Existing stores are never migrated here. They keep the explicit
 * backup/preview/apply/receipt path, even when a partial V2 schema exists.
 */
export function ensureFreshInstallV2AuthorityV1(
  sqlitePath: string,
): FreshInstallV2AuthorityV1 {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const inspection = new DatabaseSync(sqlitePath);
  try {
    inspection.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    const hasV1 = tableExists(inspection, "memory_truth");
    const hasV2 = tableExists(inspection, "memory_items");
    const hasAuthority = tableExists(inspection, "clawlore_runtime_authority");
    if (hasAuthority) {
      const row = inspection.prepare(
        "SELECT authority FROM clawlore_runtime_authority WHERE singleton=1",
      ).get() as { authority?: string } | undefined;
      const authority = row?.authority === "fresh-v2" ? "fresh-v2" : "legacy-or-migrated";
      return {
        schemaVersion: 1,
        authority,
        mayActivateWithoutMigrationReceipt: authority === "fresh-v2",
      };
    }
    const v1Rows = hasV1 ? rowCount(inspection, "memory_truth") : 0;
    const v2Rows = hasV2 ? rowCount(inspection, "memory_items") : 0;
    if (v1Rows !== 0 || v2Rows !== 0 || hasV2) {
      return {
        schemaVersion: 1,
        authority: "legacy-or-migrated",
        mayActivateWithoutMigrationReceipt: false,
      };
    }
  } finally {
    inspection.close();
  }

  // SqliteTruthStoreV2 owns the canonical schema and its integrity checks.
  const truth = new SqliteTruthStoreV2(sqlitePath);
  truth.open();
  truth.close();

  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;");
    try {
      db.exec(PROJECTION_SCHEMA_SQL);
      db.prepare(`INSERT INTO clawlore_runtime_authority
        (singleton,authority,created_at) VALUES (1,'fresh-v2',?)`)
        .run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    db.close();
  }
  return {
    schemaVersion: 1,
    authority: "fresh-v2",
    mayActivateWithoutMigrationReceipt: true,
  };
}
