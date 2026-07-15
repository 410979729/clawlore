import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../dist/src/store.js";

const root = mkdtempSync(join(tmpdir(), "clawlore-packed-lancedb-"));
const config = { dbPath: root, vectorDim: 4, vectorBackend: "lancedb" };
let store = new MemoryStore(config);
try {
  const created = await store.store({
    text: "packed native LanceDB restart and repair smoke",
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "user:packed-smoke",
    importance: 0.8,
    metadata: JSON.stringify({ state: "confirmed" }),
  });
  const initial = await store.vectorSearch([1, 0, 0, 0], 5, 0.01, ["user:packed-smoke"]);
  assert.equal(initial.some((hit) => hit.entry.id === created.id), true);
  const repair = await store.rebuildVectorCompanion({
    async embedPassage() { return [1, 0, 0, 0]; },
  }, { dryRun: true, fullRebuild: true });
  assert.equal(repair.truthCount, 1);
  assert.equal(repair.errors.length, 0);

  await store.close();
  store = new MemoryStore(config);
  assert.equal((await store.getById(created.id))?.text, created.text);
  assert.equal(await store.delete(created.id, ["user:packed-smoke"]), true);
  await store.close();

  store = new MemoryStore(config);
  assert.equal(await store.getById(created.id), null);
  assert.deepEqual(await store.vectorSearch([1, 0, 0, 0], 5, 0.01, ["user:packed-smoke"]), []);
  process.stdout.write("packed LanceDB store/reopen/recall/delete/repair smoke ok\n");
} finally {
  await store.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
