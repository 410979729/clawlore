import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { MemoryStore } = jiti("../src/store.ts");

test("existing SQL truth metadata is not overwritten by stale vector rows on startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-recall-sql-authority-"));
  const id = "00000000-0000-4000-8000-000000000011";
  let first;
  let second;

  try {
    first = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    await first.importEntry({
      id,
      text: "Raw runtime wrapper Command hints: /bin/bash -lc \"pwd\"",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "agent:test",
      importance: 0.4,
      timestamp: 1,
      metadata: JSON.stringify({
        state: "active",
        memory_layer: "episodic-digest",
      }),
    });

    const sql = new DatabaseSync(join(dir, "memory.sqlite3"));
    sql.exec("PRAGMA busy_timeout = 30000");
    sql.prepare("UPDATE memory_truth SET metadata = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        state: "archived",
        memory_layer: "archive",
        lifecycle: "archived",
      }),
      Date.now(),
      id,
    );
    sql.close();
    await first.close();
    first = undefined;

    second = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    const row = await second.getById(id);
    assert.ok(row);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.state, "archived");
    assert.equal(metadata.memory_layer, "archive");
    assert.equal(metadata.lifecycle, "archived");
    assert.deepEqual(
      await second.vectorSearch([1, 0, 0, 0], 5, 0.1, undefined, { excludeInactive: true }),
      [],
    );
  } finally {
    await second?.close();
    await first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const BACKENDS = ["lancedb", "sqlite-bruteforce"];

function entry(id, text, metadata = {}) {
  return {
    id,
    text,
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "agent:test",
    importance: 0.8,
    timestamp: 1,
    metadata: JSON.stringify({ state: "confirmed", ...metadata }),
  };
}

async function withFailingVectorMutation(store, action) {
  await store.getSqlTruthDb();
  const companion = store.sqliteVectorStore ?? store.table;
  assert.ok(companion, "vector companion initialized");
  const originals = {
    delete: companion.delete?.bind(companion),
    add: companion.add?.bind(companion),
    upsert: companion.upsert?.bind(companion),
  };
  if (companion.delete) companion.delete = store.sqliteVectorStore
    ? () => { throw new Error("injected vector delete failure"); }
    : async () => { throw new Error("injected vector delete failure"); };
  if (companion.add) companion.add = async () => { throw new Error("injected vector add failure"); };
  if (companion.upsert) companion.upsert = () => { throw new Error("injected vector upsert failure"); };
  try {
    return await action();
  } finally {
    if (originals.delete) companion.delete = originals.delete;
    if (originals.add) companion.add = originals.add;
    if (originals.upsert) companion.upsert = originals.upsert;
  }
}

async function withFailingVectorDeleteOnly(store, action) {
  await store.getSqlTruthDb();
  const companion = store.sqliteVectorStore ?? store.table;
  assert.ok(companion?.delete, "vector companion delete initialized");
  const originalDelete = companion.delete.bind(companion);
  companion.delete = store.sqliteVectorStore
    ? () => { throw new Error("injected vector delete-only failure"); }
    : async () => { throw new Error("injected vector delete-only failure"); };
  try {
    return await action();
  } finally {
    companion.delete = originalDelete;
  }
}

async function closeStoresBeforeRemoving(dir, stores) {
  for (const store of stores) await store?.close();
  rmSync(dir, { recursive: true, force: true });
}

test("test harness closes stores before recursively removing their directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-test-cleanup-order-"));
  const events = [];
  await closeStoresBeforeRemoving(dir, [
    { async close() { events.push(`first:${existsSync(dir)}`); } },
    { async close() { events.push(`second:${existsSync(dir)}`); } },
  ]);
  assert.deepEqual(events, ["first:true", "second:true"]);
  assert.equal(existsSync(dir), false);
});

for (const backend of BACKENDS) {
  test(`${backend}: stale deleted companion rows stay deleted across restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-restart-delete-${backend}-`));
    const id = "09000000-0000-4000-8000-000000000009";
    let first;
    let second;
    try {
      first = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await first.importEntry(entry(id, "restart must not resurrect this memory"));
      assert.equal(await withFailingVectorDeleteOnly(first, () => first.delete(id)), true);
      const beforeRestartDb = await first.getSqlTruthDb();
      assert.equal(beforeRestartDb.prepare("SELECT COUNT(*) AS n FROM memory_truth WHERE id = ?").get(id).n, 0);
      assert.equal(beforeRestartDb.prepare("SELECT action FROM vector_companion_repair_outbox WHERE memory_id = ?").get(id).action, "delete");
      await first.close();
      first = undefined;

      second = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      assert.equal(await second.getById(id), null);
      assert.deepEqual(await second.vectorSearch([1, 0, 0, 0], 5, 0.1), []);
      assert.deepEqual(await second.bm25Search("restart must not resurrect", 5), []);
      const afterRestartDb = await second.getSqlTruthDb();
      assert.equal(afterRestartDb.prepare("SELECT COUNT(*) AS n FROM memory_truth WHERE id = ?").get(id).n, 0);
      assert.equal(afterRestartDb.prepare("SELECT action FROM vector_companion_repair_outbox WHERE memory_id = ?").get(id).action, "delete");
      await second.close();
      second = undefined;
    } finally {
      await closeStoresBeforeRemoving(dir, [second, first]);
    }
  });

  test(`${backend}: missing SQL authority with companion rows requires explicit migration`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-missing-${backend}-`));
    const id = "08000000-0000-4000-8000-000000000008";
    const truthPath = join(dir, "memory.sqlite3");
    let first;
    let second;
    try {
      first = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await first.importEntry(entry(id, "companion is not a backup"));
      await first.close();
      first = undefined;
      for (const path of [truthPath, `${truthPath}-wal`, `${truthPath}-shm`]) {
        rmSync(path, { force: true });
      }

      second = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await assert.rejects(second.getById(id), /CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED/);
      assert.equal(second.getDiagnostics().sqlTruth.errorCode, "SQL_TRUTH_MIGRATION_REQUIRED");
      assert.equal(existsSync(truthPath), false, "startup must not create an empty truth DB before failing closed");
      await second.close();
      second = undefined;
    } finally {
      await closeStoresBeforeRemoving(dir, [second, first]);
    }
  });

  test(`${backend}: deleted SQL truth never returns when vector delete fails`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-delete-${backend}-`));
    const id = "10000000-0000-4000-8000-000000000001";
    let store;
    try {
      store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await store.importEntry(entry(id, "obsolete deploy endpoint"));
      const deleted = await withFailingVectorMutation(store, () => store.delete(id));
      assert.equal(deleted, true);
      assert.equal(await store.getById(id), null);
      assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 5, 0.1), []);
      assert.deepEqual(await store.bm25Search("obsolete deploy endpoint", 5), []);
      const db = await store.getSqlTruthDb();
      const debt = db.prepare("SELECT action, operation FROM vector_companion_repair_outbox WHERE memory_id = ?").get(id);
      assert.equal(debt.action, "delete");
      assert.equal(debt.operation, "delete");
      const repaired = await store.rebuildVectorCompanion({
        embedPassage: async () => [1, 0, 0, 0],
      });
      assert.equal(repaired.staleVectorRowsDeleted, 1);
      assert.deepEqual(repaired.errors, []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_companion_repair_outbox").get().count, 0);
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: updated recall is rehydrated only from current SQL truth`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-update-${backend}-`));
    const id = "20000000-0000-4000-8000-000000000002";
    let store;
    try {
      store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await store.importEntry(entry(id, "old deployment region", { revision: 1 }));
      const updated = await withFailingVectorMutation(store, () => store.update(id, {
        text: "current deployment region",
        vector: [0, 1, 0, 0],
        metadata: JSON.stringify({ state: "confirmed", revision: 2 }),
      }));
      assert.equal(updated.text, "current deployment region");
      const vectorHits = await store.vectorSearch([1, 0, 0, 0], 5, 0.1);
      assert.equal(vectorHits.length, 1);
      assert.equal(vectorHits[0].entry.text, "current deployment region");
      assert.equal(JSON.parse(vectorHits[0].entry.metadata).revision, 2);
      const oldQueryHits = await store.bm25Search("old deployment region", 5);
      assert.ok(oldQueryHits.every((hit) => hit.entry.text === "current deployment region"));
      assert.equal((await store.bm25Search("current deployment region", 5))[0].entry.id, id);
      const db = await store.getSqlTruthDb();
      const debt = db.prepare("SELECT action FROM vector_companion_repair_outbox WHERE memory_id = ?").get(id);
      assert.equal(debt.action, "upsert");
      const repaired = await store.rebuildVectorCompanion({
        embedPassage: async (text) => text.includes("current") ? [0, 1, 0, 0] : [1, 0, 0, 0],
      });
      assert.equal(repaired.processed, 1, "durable upsert debt must rebuild even when a stale vector id exists");
      assert.equal(repaired.rebuilt, 1);
      assert.deepEqual(repaired.errors, []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_companion_repair_outbox").get().count, 0);
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: successful add after failed delete retains durable upsert repair debt`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-mixed-${backend}-`));
    const updateId = "25000000-0000-4000-8000-000000000002";
    const supersedeId = "35000000-0000-4000-8000-000000000003";
    let store;
    try {
      store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await store.importEntry(entry(updateId, "old mixed update", { revision: 1 }));
      await withFailingVectorDeleteOnly(store, () => store.update(updateId, {
        text: "current mixed update",
        vector: [0, 1, 0, 0],
        metadata: JSON.stringify({ state: "confirmed", revision: 2 }),
      }));

      await store.importEntry(entry(supersedeId, "old mixed supersede", { fact_key: "mixed-fact" }));
      const replacement = await withFailingVectorDeleteOnly(store, () => store.supersede(supersedeId, {
        text: "current mixed supersede",
        vector: [0, 1, 0, 0],
        category: "fact",
        importance: 0.9,
        buildMetadata({ oldEntry, newId, now }) {
          return {
            factKey: "mixed-fact",
            oldMetadata: JSON.stringify({
              ...JSON.parse(oldEntry.metadata),
              fact_key: "mixed-fact",
              invalidated_at: now,
              valid_to: now,
              superseded_by: newId,
              state: "confirmed",
            }),
            newMetadata: JSON.stringify({ fact_key: "mixed-fact", valid_from: now, state: "confirmed" }),
          };
        },
      }));

      const db = await store.getSqlTruthDb();
      const debts = db.prepare(
        "SELECT memory_id, action, operation FROM vector_companion_repair_outbox ORDER BY memory_id",
      ).all().map((row) => ({ ...row }));
      assert.deepEqual(debts, [
        {
          memory_id: updateId,
          action: "upsert",
          operation: "update-add-vector-reconcile",
        },
        {
          memory_id: supersedeId,
          action: "upsert",
          operation: "supersede-add-invalidated-old-vector-reconcile",
        },
      ].sort((a, b) => a.memory_id.localeCompare(b.memory_id)));
      assert.equal(debts.some((row) => row.memory_id === replacement.id), false);

      const repaired = await store.rebuildVectorCompanion({
        embedPassage: async (text) => text.includes("current") ? [0, 1, 0, 0] : [1, 0, 0, 0],
      });
      assert.equal(repaired.processed, 2);
      assert.equal(repaired.rebuilt, 2);
      assert.deepEqual(repaired.errors, []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_companion_repair_outbox").get().count, 0);
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: superseded stale vector is inactive and replacement remains SQL-recallable`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-supersede-${backend}-`));
    const id = "30000000-0000-4000-8000-000000000003";
    let store;
    try {
      store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await store.importEntry(entry(id, "legacy hostname", { fact_key: "service-host" }));
      const replacement = await withFailingVectorMutation(store, () => store.supersede(id, {
        text: "canonical hostname",
        vector: [0, 1, 0, 0],
        category: "fact",
        importance: 0.9,
        buildMetadata({ oldEntry, newId, now }) {
          return {
            factKey: "service-host",
            oldMetadata: JSON.stringify({
              ...JSON.parse(oldEntry.metadata),
              fact_key: "service-host",
              invalidated_at: now,
              valid_to: now,
              superseded_by: newId,
              state: "confirmed",
            }),
            newMetadata: JSON.stringify({
              fact_key: "service-host",
              valid_from: now,
              state: "confirmed",
            }),
          };
        },
      }));
      assert.notEqual(replacement.id, id);
      assert.deepEqual(
        await store.vectorSearch([1, 0, 0, 0], 5, 0.1, undefined, { excludeInactive: true }),
        [],
      );
      const legacyQueryHits = await store.bm25Search("legacy hostname", 5, undefined, { excludeInactive: true });
      assert.ok(legacyQueryHits.every((hit) => hit.entry.id !== id && hit.entry.text !== "legacy hostname"));
      const replacementHits = await store.bm25Search("canonical hostname", 5, undefined, { excludeInactive: true });
      assert.equal(replacementHits.length, 1);
      assert.equal(replacementHits[0].entry.id, replacement.id);
      const db = await store.getSqlTruthDb();
      const debts = db.prepare("SELECT memory_id, action FROM vector_companion_repair_outbox ORDER BY memory_id").all();
      assert.deepEqual(debts.map((row) => ({ ...row })), [
        { memory_id: id, action: "upsert" },
        { memory_id: replacement.id, action: "upsert" },
      ].sort((a, b) => a.memory_id.localeCompare(b.memory_id)));
      const repaired = await store.rebuildVectorCompanion({
        embedPassage: async (text) => text.includes("canonical") ? [0, 1, 0, 0] : [1, 0, 0, 0],
      });
      assert.equal(repaired.processed, 2);
      assert.equal(repaired.rebuilt, 2);
      assert.deepEqual(repaired.errors, []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_companion_repair_outbox").get().count, 0);
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: SQL scope is authoritative when the vector companion has stale scope metadata`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `clawlore-sql-scope-${backend}-`));
    const id = "40000000-0000-4000-8000-000000000004";
    let store;
    try {
      store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: backend });
      await store.importEntry(entry(id, "principal scoped current truth"));
      const db = await store.getSqlTruthDb();
      db.prepare("UPDATE memory_truth SET scope = ?, updated_at = ? WHERE id = ?")
        .run("user:current", Date.now(), id);
      const hits = await store.vectorSearch([1, 0, 0, 0], 5, 0.1, ["user:current"]);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].entry.id, id);
      assert.equal(hits[0].entry.scope, "user:current");
      assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 5, 0.1, ["agent:test"]), []);
    } finally {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
