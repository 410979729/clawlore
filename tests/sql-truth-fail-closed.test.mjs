import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("fresh install writes an authority marker and legacy non-empty authority upgrades once", () => {
  const freshDir = mkdtempSync(join(tmpdir(), "clawlore-truth-marker-fresh-"));
  const legacyDir = mkdtempSync(join(tmpdir(), "clawlore-truth-marker-legacy-"));
  try {
    const freshPath = join(freshDir, "memory.sqlite3");
    const fresh = new SqlTruthStore(freshPath);
    fresh.open();
    fresh.close();
    assert.equal(SqlTruthStore.inspectAuthority(freshPath).status, "valid");

    const legacyPath = join(legacyDir, "memory.sqlite3");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE memory_truth (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL, importance REAL NOT NULL, timestamp REAL NOT NULL,
        metadata TEXT NOT NULL, metadata_text TEXT NOT NULL, updated_at REAL NOT NULL
      );
      CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, text, metadata_text);
    `);
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
    db.close();
    assert.equal(SqlTruthStore.inspectAuthority(legacyPath).status, "legacy");
    const legacy = new SqlTruthStore(legacyPath);
    legacy.open({ allowCreate: false, allowLegacyUpgrade: true });
    legacy.close();
    assert.equal(SqlTruthStore.inspectAuthority(legacyPath).status, "valid");
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
