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
        /CLAWLORE_SQL_TRUTH_UNAVAILABLE/,
      );
      await assert.rejects(store.getById(staleEntry.id), /CLAWLORE_SQL_TRUTH_UNAVAILABLE/);
      await assert.rejects(store.store({
        text: "write must also fail closed",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "user:private-a",
        importance: 0.5,
      }), /CLAWLORE_SQL_TRUTH_UNAVAILABLE/);
      assert.equal(store.getDiagnostics().sqlTruth.errorCode, "SQL_TRUTH_UNAVAILABLE");
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
    const restored = new DatabaseSync(truthPath);
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
