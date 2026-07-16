import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");
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
    ${options.truthSql ?? `CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      scope TEXT NOT NULL, importance REAL NOT NULL, timestamp REAL NOT NULL,
      metadata TEXT NOT NULL, metadata_text TEXT NOT NULL, updated_at REAL NOT NULL
    );`}
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
    verifyPrivatePath(backupPath, { kind: "file" });
    verifyPrivatePath(receiptPath, { kind: "file" });
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
  const backupPath = join(dir, "backups", "backup.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
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
  const backupPath = join(dir, "backups", "backup.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
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

test("authority inspection rejects a truth table whose id is not PRIMARY KEY or UNIQUE", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-contract-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  try {
    createLegacyAuthority(sqlitePath, {
      truthSql: `CREATE TABLE memory_truth (
        id TEXT, text TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL, importance REAL NOT NULL, timestamp REAL NOT NULL,
        metadata TEXT NOT NULL, metadata_text TEXT NOT NULL, updated_at REAL NOT NULL
      );`,
    });
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    assert.equal(inspection.status, "untrusted");
    assert.equal(inspection.reason, "authority_truth_contract_incompatible");
    const store = new SqlTruthStore(sqlitePath);
    assert.throws(() => store.open({ allowCreate: false }), /CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mutation of [
  {
    name: "replacement outbox contract",
    apply(db) {
      db.exec(`DROP TABLE vector_companion_repair_outbox;
        CREATE TABLE vector_companion_repair_outbox (
          memory_id TEXT PRIMARY KEY, action TEXT, operation TEXT, last_error TEXT,
          attempts INTEGER, created_at REAL, updated_at REAL
        );`);
    },
  },
  {
    name: "replacement active-fact trigger",
    apply(db) {
      db.exec(`DROP TRIGGER memory_truth_single_active_fact_insert;
        CREATE TRIGGER memory_truth_single_active_fact_insert
        BEFORE INSERT ON memory_truth BEGIN SELECT 1; END;`);
    },
  },
  {
    name: "an unexpected AFTER INSERT trigger",
    apply(db) {
      db.exec(`CREATE TRIGGER unexpected_delete_after_insert
        AFTER INSERT ON memory_truth
        BEGIN DELETE FROM memory_truth WHERE id = NEW.id; END;`);
    },
  },
  {
    name: "an unexpected BEFORE UPDATE trigger",
    apply(db) {
      db.exec(`CREATE TRIGGER unexpected_ignore_before_update
        BEFORE UPDATE ON memory_truth
        BEGIN SELECT RAISE(IGNORE); END;`);
    },
  },
  {
    name: "an unexpected BEFORE DELETE trigger",
    apply(db) {
      db.exec(`CREATE TRIGGER unexpected_ignore_before_delete
        BEFORE DELETE ON memory_truth
        BEGIN SELECT RAISE(IGNORE); END;`);
    },
  },
  {
    name: "an unexpected protected-table index",
    apply(db) {
      db.exec("CREATE INDEX unexpected_memory_truth_text ON memory_truth(text)");
    },
  },
  {
    name: "an unexpected ClawLore namespace view",
    apply(db) {
      db.exec("CREATE VIEW clawlore_unexpected_truth_view AS SELECT id FROM memory_truth");
    },
  },
]) test(`marked authority rejects ${mutation.name} despite matching object names`, () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-fingerprint-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  try {
    const store = new SqlTruthStore(sqlitePath);
    store.open();
    store.close();
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "valid");
    const db = new DatabaseSync(sqlitePath);
    mutation.apply(db);
    db.close();
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    assert.equal(inspection.status, "untrusted");
    assert.equal(inspection.reason, "authority_schema_fingerprint_mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every valid authority fixture preserves CRUD, FTS, and durable state", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-valid-crud-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  try {
    const store = new SqlTruthStore(sqlitePath);
    store.open();
    const original = { ...staleEntry, text: "valid authority durable insert", scope: "agent:main" };
    store.upsert(original);
    assert.equal(store.getById(original.id)?.text, original.text);
    assert.equal(store.search("durable insert", 5, ["agent:main"])[0]?.entry.id, original.id);
    const updated = { ...original, text: "valid authority durable update", timestamp: 2 };
    store.upsert(updated);
    assert.equal(store.getById(updated.id)?.text, updated.text);
    assert.deepEqual(store.ftsIntegrityReport(), {
      truthRows: 1,
      ftsRows: 1,
      staleFtsRows: 0,
      missingFtsRows: 0,
      duplicateFtsExtraRows: 0,
      healthy: true,
    });
    store.delete(updated.id);
    assert.equal(store.getById(updated.id), null);
    assert.equal(store.count(), 0);
    assert.equal(store.ftsIntegrityReport().healthy, true);
    store.close();
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "valid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy authority migration preserves compatible vector repair debt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-repair-migrate-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backups", "memory.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec(`CREATE TABLE vector_companion_repair_outbox (
      memory_id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK(action IN ('upsert', 'delete')),
      operation TEXT NOT NULL,
      last_error TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE INDEX idx_vector_companion_repair_updated_at
      ON vector_companion_repair_outbox(updated_at ASC);`);
    db.prepare(`INSERT INTO vector_companion_repair_outbox (
      memory_id, action, operation, last_error, attempts, created_at, updated_at
    ) VALUES (?, 'upsert', 'legacy-repair', 'pending', 3, 10, 20)`).run(staleEntry.id);
    db.close();

    const receipt = await migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath });
    assert.equal(receipt.status, "completed");
    const upgraded = new SqlTruthStore(sqlitePath);
    upgraded.open({ allowCreate: false });
    assert.deepEqual(upgraded.listVectorRepairDebt(), [{
      memoryId: staleEntry.id,
      action: "upsert",
      operation: "legacy-repair",
      attempts: 3,
      createdAt: 10,
      updatedAt: 20,
    }]);
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy authority migration rejects an incompatible vector repair outbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-repair-incompatible-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backups", "memory.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec("CREATE TABLE vector_companion_repair_outbox (memory_id TEXT PRIMARY KEY, action TEXT)");
    db.close();
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    assert.equal(inspection.status, "untrusted");
    assert.equal(inspection.reason, "legacy_repair_outbox_incompatible");
    assert.equal(inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath }).status, "blocked");
    await assert.rejects(
      migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath }),
      /LEGACY_UPGRADE_REFUSED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration rejects source, backup, and receipt aliases before any write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-alias-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  try {
    createLegacyAuthority(sqlitePath);
    const sameOutput = join(dir, "migration-output");
    for (const params of [
      { sqlitePath, backupPath: sameOutput, receiptPath: sameOutput },
      { sqlitePath, backupPath: sqlitePath, receiptPath: join(dir, "receipts", "receipt.json") },
      {
        sqlitePath,
        backupPath: join(dir, "backups", "../receipts", "receipt.json"),
        receiptPath: join(dir, "receipts", "receipt.json"),
      },
    ]) {
      const plan = inspectLegacyAuthorityMigration(params);
      assert.equal(plan.status, "blocked");
      await assert.rejects(() => migrateLegacySqlAuthority(params), /paths must be distinct|aliases/);
    }
    assert.equal(existsSync(sameOutput), false);
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration resolves symlinked output parents before alias comparison", {
  skip: process.platform === "win32",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-symlink-alias-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const outputDirectory = join(dir, "outputs");
  const aliasDirectory = join(dir, "outputs-alias");
  try {
    createLegacyAuthority(sqlitePath);
    mkdirSync(outputDirectory, { mode: 0o700 });
    symlinkSync(outputDirectory, aliasDirectory, "dir");
    const params = {
      sqlitePath,
      backupPath: join(outputDirectory, "migration-output"),
      receiptPath: join(aliasDirectory, "migration-output"),
    };
    assert.equal(inspectLegacyAuthorityMigration(params).status, "blocked");
    await assert.rejects(() => migrateLegacySqlAuthority(params), /paths must be distinct|aliases/);
    assert.equal(readdirSync(outputDirectory).length, 0);
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration never rewrites an existing shared parent directory", {
  skip: process.platform === "win32",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-shared-parent-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const shared = join(dir, "shared-backups");
  const receiptDirectory = join(dir, "receipts");
  try {
    createLegacyAuthority(sqlitePath);
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    writeFileSync(join(shared, "sibling-sentinel.txt"), "must remain shared\n");
    const params = {
      sqlitePath,
      backupPath: join(shared, "memory.sqlite3"),
      receiptPath: join(receiptDirectory, "receipt.json"),
    };
    const plan = inspectLegacyAuthorityMigration(params);
    assert.equal(plan.status, "blocked");
    assert.match(plan.reason, /backup_directory_(?:not_private|not_dedicated)/);
    await assert.rejects(() => migrateLegacySqlAuthority(params), /LEGACY_UPGRADE_REFUSED/);
    assert.equal(lstatSync(shared).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(shared, "sibling-sentinel.txt"), "utf8"), "must remain shared\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration cleans pre-receipt backup failures and remains retryable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-backup-fault-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupDirectory = join(dir, "backups");
  const receiptDirectory = join(dir, "receipts");
  const backupPath = join(backupDirectory, "backup.sqlite3");
  const receiptPath = join(receiptDirectory, "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    await assert.rejects(
      migrateLegacySqlAuthority({
        sqlitePath,
        backupPath,
        receiptPath,
        faultInjector(point) {
          if (point === "backup_before_fsync") throw new Error("fixture_backup_before_fsync");
        },
      }),
      /fixture_backup_before_fsync/,
    );
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "legacy");
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(existsSync(backupDirectory), false);
    assert.equal(existsSync(receiptDirectory), false);
    assert.equal(inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath }).status, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const faultPoint of ["prepared_receipt_before_temp_fsync", "prepared_receipt_after_temp_fsync"]) {
  test(`authority migration cleans ${faultPoint} and remains retryable`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-receipt-sync-fault-"));
    const sqlitePath = join(dir, "memory.sqlite3");
    const backupDirectory = join(dir, "backups");
    const receiptDirectory = join(dir, "receipts");
    const backupPath = join(backupDirectory, "backup.sqlite3");
    const receiptPath = join(receiptDirectory, "receipt.json");
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
      assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "legacy");
      assert.equal(existsSync(backupPath), false);
      assert.equal(existsSync(receiptPath), false);
      assert.equal(existsSync(backupDirectory), false);
      assert.equal(existsSync(receiptDirectory), false);
      assert.equal(inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath }).status, "ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("authority migration aborts when source content changes after the durable backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-drift-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backups", "memory.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    await assert.rejects(
      migrateLegacySqlAuthority({
        sqlitePath,
        backupPath,
        receiptPath,
        faultInjector(point) {
          if (point !== "backup_after_fsync") return;
          const writer = new DatabaseSync(sqlitePath);
          writer.prepare("UPDATE memory_truth SET text = ? WHERE id = ?")
            .run("concurrent durable update", staleEntry.id);
          writer.close();
        },
      }),
      /source changed after backup snapshot/,
    );
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "legacy");
    const source = new DatabaseSync(sqlitePath, { readOnly: true });
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(source.prepare("SELECT text FROM memory_truth WHERE id = ?").get(staleEntry.id).text, "concurrent durable update");
    assert.equal(backup.prepare("SELECT text FROM memory_truth WHERE id = ?").get(staleEntry.id).text, staleEntry.text);
    source.close();
    backup.close();
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration reconstructs a completed external receipt from committed internal truth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-recover-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backups", "memory.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    const receipt = await migrateLegacySqlAuthority({
      sqlitePath,
      backupPath,
      receiptPath,
      faultInjector(point) {
        if (point === "migration_after_commit") throw new Error("fixture_external_receipt_interruption");
      },
    });
    assert.equal(receipt.status, "completed");
    assert.equal(typeof receipt.recoveredAt, "string");
    assert.match(receipt.sourceSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(SqlTruthStore.inspectAuthority(sqlitePath).status, "valid");
    const persisted = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.migrationId, receipt.migrationId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority migration rebuilds every malformed completed external receipt field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-migration-receipt-bind-"));
  const sqlitePath = join(dir, "memory.sqlite3");
  const backupPath = join(dir, "backups", "memory.sqlite3");
  const receiptPath = join(dir, "receipts", "receipt.json");
  try {
    createLegacyAuthority(sqlitePath);
    const original = await migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath });
    const corruptions = [
      ["version", 2],
      ["migrationId", "wrong-migration-id"],
      ["sourceDatabase", "wrong-source.sqlite3"],
      ["backupDatabase", "wrong-backup.sqlite3"],
      ["receiptFile", "wrong-receipt.json"],
      ["backupSha256", "0".repeat(64)],
      ["sourceSnapshotSha256", "f".repeat(64)],
      ["sourceTruthRows", 999],
      ["completedAt", "2020-01-01T00:00:00.000Z"],
      ["preparedAt", "2020-01-01T00:00:00.000Z"],
      ["backupDurableAt", "2020-01-01T00:00:01.000Z"],
      ["lockProtocol", "wrong-lock"],
      ["postInspection", { status: "valid", truthRows: 999 }],
    ];
    for (const [field, value] of corruptions) {
      writeFileSync(receiptPath, `${JSON.stringify({ ...original, [field]: value }, null, 2)}\n`);
      const plan = inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath });
      assert.equal(plan.status, "recoverable", field);
      assert.equal(plan.reason, "external_receipt_corrupt_recoverable", field);
      const recovered = await migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath });
      assert.equal(recovered.status, "completed", field);
      assert.equal(recovered.version, 3, field);
      assert.equal(recovered.migrationId, original.migrationId, field);
      assert.equal(
        inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath }).reason,
        "migration_already_completed",
        field,
      );
    }
    writeFileSync(receiptPath, "{\"status\":\"completed\"");
    assert.equal(
      inspectLegacyAuthorityMigration({ sqlitePath, backupPath, receiptPath }).status,
      "recoverable",
    );
    const recovered = await migrateLegacySqlAuthority({ sqlitePath, backupPath, receiptPath });
    assert.equal(recovered.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
