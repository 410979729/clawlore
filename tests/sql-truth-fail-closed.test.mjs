import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");
const { SqlTruthStore } = jiti("../src/sql-truth-store.ts");
const { SqliteBruteForceVectorStore } = jiti("../src/sqlite-vector-store.ts");
const { inspectLegacyAuthorityMigration, migrateLegacySqlAuthority } = jiti("../src/sql-authority-migration.ts");

const staleEntry = {
  id: "90000000-0000-4000-8000-000000000001",
  text: "stale companion must never become truth",
  vector: [1, 0, 0, 0],
  category: "fact",
  scope: "user:private-a",
  importance: 0.9,
  timestamp: 1,
  metadata: JSON.stringify({ state: "confirmed" }),
};

function createLegacyAuthority(path, options = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      scope TEXT NOT NULL, importance REAL NOT NULL, timestamp REAL NOT NULL,
      metadata TEXT NOT NULL, metadata_text TEXT NOT NULL, updated_at REAL NOT NULL
    );
    ${options.ftsSql ?? "CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, text, metadata_text);"}
  `);
  if (options.insert !== false) {
    db.prepare(`INSERT INTO memory_truth (
      id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      staleEntry.id,
      staleEntry.text,
      staleEntry.category,
      staleEntry.scope,
      staleEntry.importance,
      staleEntry.timestamp,
      staleEntry.metadata,
      "",
      Date.now(),
    );
  }
  db.close();
}

const scenarios = [
  {
    name: "truth path is a directory",
    prepare(path) { mkdirSync(path); },
  },
  {
    name: "truth database is corrupt",
    prepare(path) { writeFileSync(path, "not-a-sqlite-database"); },
  },
  {
    name: "truth schema migration is incompatible",
    prepare(path) {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE memory_truth (id TEXT PRIMARY KEY)");
      db.close();
    },
  },
  {
    name: "truth database is zero bytes",
    prepare(path) { writeFileSync(path, ""); },
  },
  {
    name: "truth database is a valid but empty SQLite file",
    prepare(path) {
      const db = new DatabaseSync(path);
      db.close();
    },
  },
  ...(typeof process.getuid === "function" && process.getuid() !== 0 ? [{
    name: "truth database permissions deny access",
    prepare(path) {
      writeFileSync(path, "");
      chmodSync(path, 0o000);
    },
    cleanup(path) { chmodSync(path, 0o600); },
  }] : []),
];

for (const scenario of scenarios) {
  test(`SQL truth outage fails closed when ${scenario.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-outage-"));
    const truthPath = join(dir, "memory.sqlite3");
    try {
      const vector = new SqliteBruteForceVectorStore(dir, 4);
      vector.open();
      vector.upsert(staleEntry);
      vector.close();
      scenario.prepare(truthPath);

      const store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
      await assert.rejects(
        store.vectorSearch([1, 0, 0, 0], 5, 0.1),
        /CLAWLORE_SQL_TRUTH_(?:UNAVAILABLE|MIGRATION_REQUIRED)/,
      );
      await assert.rejects(store.getById(staleEntry.id), /CLAWLORE_SQL_TRUTH_(?:UNAVAILABLE|MIGRATION_REQUIRED)/);
      await assert.rejects(store.store({
        text: "write must also fail closed",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "user:private-a",
        importance: 0.5,
      }), /CLAWLORE_SQL_TRUTH_(?:UNAVAILABLE|MIGRATION_REQUIRED)/);
      assert.ok(
        ["SQL_TRUTH_UNAVAILABLE", "SQL_TRUTH_MIGRATION_REQUIRED"].includes(store.getDiagnostics().sqlTruth.errorCode),
      );
    } finally {
      try { scenario.cleanup?.(truthPath); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("authority outage is latched until explicit recovery and does not retry every request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-outage-latch-"));
  const truthPath = join(dir, "memory.sqlite3");
  const originalError = console.error;
  let errorLogs = 0;
  try {
    const vector = new SqliteBruteForceVectorStore(dir, 4);
    vector.open();
    vector.upsert(staleEntry);
    vector.close();
    mkdirSync(truthPath);
    console.error = () => { errorLogs++; };

    const store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, () => store.getById(staleEntry.id)),
    );
    assert.ok(attempts.every((result) => result.status === "rejected"));
    const firstReason = attempts[0].reason;
    assert.ok(attempts.every((result) => result.reason === firstReason));
    assert.equal(errorLogs, 1, "one authority outage must produce one initialization attempt/log");

    rmSync(truthPath, { recursive: true, force: true });
    const restored = new SqlTruthStore(truthPath);
    restored.open();
    restored.close();
    await store.reopenAfterRecovery();
    assert.equal(await store.getById(staleEntry.id), null);
    assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 5, 0.1), []);
    await store.close();
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid marker-backed zero-row authority hides stale companion and remains healthy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-marker-empty-"));
  try {
    const vector = new SqliteBruteForceVectorStore(dir, 4);
    vector.open();
    vector.upsert(staleEntry);
    vector.close();

    const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
    truth.open();
    truth.recordVectorRepairDebt({
      memoryId: staleEntry.id,
      action: "delete",
      operation: "verified-restore-delete",
      error: "pending_vector_companion_sync",
    });
    truth.close();

    const store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    assert.equal(await store.getById(staleEntry.id), null);
    assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 5, 0.1), []);
    assert.equal(store.getDiagnostics().sqlTruth.errorCode, null);
    assert.equal(store.getDiagnostics().sqlTruth.fts?.healthy, true);
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh install writes an authority marker and legacy upgrade requires backup plus receipt", async () => {
  const freshDir = mkdtempSync(join(tmpdir(), "clawlore-truth-marker-fresh-"));
  const legacyDir = mkdtempSync(join(tmpdir(), "clawlore-truth-marker-legacy-"));
  try {
    const freshPath = join(freshDir, "memory.sqlite3");
    const fresh = new SqlTruthStore(freshPath);
    fresh.open();
    fresh.close();
    assert.equal(SqlTruthStore.inspectAuthority(freshPath).status, "valid");

    const legacyPath = join(legacyDir, "memory.sqlite3");
    createLegacyAuthority(legacyPath);
    assert.equal(SqlTruthStore.inspectAuthority(legacyPath).status, "legacy");
    const legacy = new SqlTruthStore(legacyPath);
    assert.throws(() => legacy.open({ allowCreate: false }), /CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED/);
    const backupPath = join(legacyDir, "backups", "memory.before-authority.sqlite3");
    const receiptPath = join(legacyDir, "receipts", "authority-migration.json");
    assert.equal(inspectLegacyAuthorityMigration({ sqlitePath: legacyPath, backupPath, receiptPath }).status, "ready");
    const receipt = await migrateLegacySqlAuthority({ sqlitePath: legacyPath, backupPath, receiptPath });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.sourceTruthRows, 1);
    assert.equal(existsSync(backupPath), true);
    assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).status, "completed");
    assert.equal(SqlTruthStore.inspectAuthority(legacyPath).status, "valid");
    const opened = new SqlTruthStore(legacyPath);
    opened.open({ allowCreate: false });
    assert.equal(opened.count(), 1);
    opened.close();
    assert.equal(inspectLegacyAuthorityMigration({ sqlitePath: legacyPath, backupPath, receiptPath }).status, "blocked");
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "same-name ordinary FTS table",
    ftsSql: "CREATE TABLE memory_truth_fts (memory_id TEXT, text TEXT, metadata_text TEXT);",
  },
  {
    name: "same-name FTS view",
    ftsSql: "CREATE VIEW memory_truth_fts AS SELECT id AS memory_id, text, metadata_text FROM memory_truth;",
  },
  {
    name: "FTS5 table with wrong columns",
    ftsSql: "CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, body, metadata_text);",
  },
]) test(`authority inspection rejects ${scenario.name} before mutation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-structural-probe-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backup.sqlite3");
  const receiptPath = join(dir, "receipt.json");
  try {
    createLegacyAuthority(sqlitePath, { ftsSql: scenario.ftsSql });
    const before = new DatabaseSync(sqlitePath);
    const objectsBefore = before.prepare("SELECT name, type FROM sqlite_master ORDER BY name").all();
    before.close();
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    assert.equal(inspection.status, "untrusted");
    assert.match(inspection.reason, /fts_schema|core_schema/);
    await assert.rejects(
      migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath }),
      /CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED/,
    );
    const after = new DatabaseSync(sqlitePath);
    const objectsAfter = after.prepare("SELECT name, type FROM sqlite_master ORDER BY name").all();
    after.close();
    assert.deepEqual(objectsAfter, objectsBefore);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const faultPoint of [
  "schema_after_ddl",
  "schema_after_fts_reconcile",
  "schema_before_authority_marker",
  "schema_after_authority_marker",
]) test(`legacy authority migration rolls back atomically at ${faultPoint}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-fault-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backup.sqlite3");
  const receiptPath = join(dir, "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    await assert.rejects(
      migrateLegacySqlAuthority({
        sqlitePath,
        backupPath,
        receiptPath,
        faultInjector(point) {
          if (point === faultPoint) throw new Error(`fixture_${faultPoint}`);
        },
      }),
      new RegExp(`fixture_${faultPoint}`),
    );
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    assert.equal(inspection.status, "legacy");
    assert.equal(inspection.truthRows, 1);
    const db = new DatabaseSync(sqlitePath);
    const unexpected = db.prepare(`SELECT name FROM sqlite_master
      WHERE name IN ('clawlore_sql_truth_authority','clawlore_sql_truth_migrations','vector_companion_repair_outbox')`).all();
    db.close();
    assert.deepEqual(unexpected, []);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
