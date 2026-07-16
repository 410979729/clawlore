import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqlTruthStore } = jiti("../src/sql-truth-store.ts");
const { MemoryStore } = jiti("../src/store.ts");

function entry(id, text = "atomic truth row") {
  return {
    id,
    text,
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "user:atomic",
    importance: 0.8,
    timestamp: 1,
    metadata: JSON.stringify({ state: "confirmed" }),
  };
}

function counts(db) {
  return {
    truth: db.prepare("SELECT COUNT(*) AS n FROM memory_truth").get().n,
    fts: db.prepare("SELECT COUNT(*) AS n FROM memory_truth_fts").get().n,
    outbox: db.prepare("SELECT COUNT(*) AS n FROM vector_companion_repair_outbox").get().n,
  };
}

test("truth, FTS, and vector intent roll back together under injected faults", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-atomic-"));
  let failAt = "";
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"), (point) => {
    if (point === failAt) throw new Error(`injected ${point}`);
  });
  try {
    truth.open();
    const db = truth.getDb();

    failAt = "fts_before_insert";
    assert.throws(() => truth.upsertWithVectorIntent(entry("a"), "store"), /injected/);
    assert.deepEqual(counts(db), { truth: 0, fts: 0, outbox: 0 });

    failAt = "vector_intent_before_insert";
    assert.throws(() => truth.upsertWithVectorIntent(entry("b"), "store"), /injected/);
    assert.deepEqual(counts(db), { truth: 0, fts: 0, outbox: 0 });

    failAt = "";
    truth.upsertWithVectorIntent(entry("c"), "store");
    truth.clearVectorRepairDebt("c");
    assert.deepEqual(counts(db), { truth: 1, fts: 1, outbox: 0 });

    failAt = "fts_before_delete";
    assert.throws(() => truth.deleteWithVectorIntent("c", "delete"), /injected/);
    assert.deepEqual(counts(db), { truth: 1, fts: 1, outbox: 0 });

    failAt = "";
    truth.deleteWithVectorIntent("c", "delete");
    assert.deepEqual(counts(db), { truth: 0, fts: 0, outbox: 1 });
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permission enforcement failures roll back every durable mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-permission-atomic-"));
  let failAt = "";
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"), (point) => {
    if (point === failAt) throw new Error(`injected ${point}`);
  });
  try {
    truth.open();
    const db = truth.getDb();
    const old = entry("permission-old", "old atomic fact");
    truth.upsertWithVectorIntent(old, "seed");
    truth.clearVectorRepairDebt(old.id);

    failAt = "permissions_before_enforce";
    const baseline = counts(db);
    assert.throws(
      () => truth.upsertWithVectorIntent(entry("permission-new"), "store"),
      /injected permissions_before_enforce/,
    );
    assert.deepEqual(counts(db), baseline);

    assert.throws(
      () => truth.deleteWithVectorIntent(old.id, "delete"),
      /injected permissions_before_enforce/,
    );
    assert.deepEqual(counts(db), baseline);
    assert.equal(truth.getById(old.id)?.text, "old atomic fact");

    const now = Date.now();
    const invalidatedOld = {
      ...old,
      metadata: JSON.stringify({
        state: "confirmed",
        fact_key: "permission-fact",
        invalidated_at: now,
        valid_to: now,
        superseded_by: "permission-replacement",
      }),
    };
    const replacement = {
      ...entry("permission-replacement", "new atomic fact"),
      metadata: JSON.stringify({ state: "confirmed", fact_key: "permission-fact", valid_from: now }),
    };
    assert.throws(
      () => truth.supersedeAtomically(invalidatedOld, replacement, "permission-fact"),
      /injected permissions_before_enforce/,
    );
    assert.deepEqual(counts(db), baseline);
    assert.equal(truth.getById(replacement.id), null);

    failAt = "";
    truth.recordVectorRepairDebt({
      memoryId: old.id,
      action: "upsert",
      operation: "permission-test",
      error: "pending",
    });
    const debtBaseline = counts(db);
    failAt = "permissions_before_enforce";
    assert.throws(
      () => truth.clearVectorRepairDebt(old.id),
      /injected permissions_before_enforce/,
    );
    assert.deepEqual(counts(db), debtBaseline);
    assert.equal(truth.listVectorRepairDebt().some((row) => row.memoryId === old.id), true);
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQL truth search errors return fail-closed empty results with stable diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-truth-search-failure-"));
  let store;
  try {
    store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    await store.importEntry(entry("d", "searchable durable truth"));
    store.sqlTruthStore.search = () => { throw new Error("private path /home/a and token-shaped canary"); };
    assert.deepEqual(await store.bm25Search("searchable", 5), []);
    const status = store.getFtsStatus();
    assert.match(status.lastError, /^SQL_TRUTH_SEARCH_FAILED:/);
    assert.equal(status.lastError.includes("/home/a"), false);
  } finally {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
