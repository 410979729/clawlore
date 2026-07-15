import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");

test("vector hydration expands beyond 200 stale companion rows within a bounded scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-vector-pagination-"));
  try {
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    const valid = {
      id: "91000000-0000-4000-8000-000000000001",
      text: "valid row behind stale vector crowd",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "user:a",
      importance: 0.9,
      timestamp: 1,
      metadata: JSON.stringify({ state: "confirmed" }),
    };
    await store.importEntry(valid);
    for (let index = 0; index < 250; index++) {
      store.sqliteVectorStore.upsert({
        ...valid,
        id: `stale-${String(index).padStart(4, "0")}`,
        text: `stale ${index}`,
        timestamp: 10_000 + index,
      });
    }
    const originalSearch = store.sqliteVectorStore.search.bind(store.sqliteVectorStore);
    const limits = [];
    store.sqliteVectorStore.search = (...args) => {
      limits.push(args[1]);
      return originalSearch(...args);
    };

    const results = await store.vectorSearch([1, 0, 0, 0], 1, 0.1, ["user:a"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, valid.id);
    assert.ok(limits.some((limit) => limit > 200));
    assert.ok(Math.max(...limits) <= 5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vector scan budget exhaustion is explicit in diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-vector-budget-diagnostic-"));
  try {
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    await store.getSqlTruthDb();
    store.sqliteVectorStore.search = (_vector, limit) => Array.from({ length: limit }, (_, index) => ({
      entry: {
        id: `stale-budget-${index}`,
        text: `stale ${index}`,
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "user:a",
        importance: 1,
        timestamp: index,
        metadata: "{}",
      },
      score: 1,
    }));

    assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 1, 0.1, ["user:a"]), []);
    const diagnostics = store.getDiagnostics().vectorCompanion;
    assert.equal(diagnostics.scanBudgetExhaustions, 1);
    assert.equal(typeof diagnostics.lastScanBudgetExhaustedAt, "number");
    assert.equal(diagnostics.needsRepair, true);
    assert.match(diagnostics.message, /scan budget exhausted/);
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
