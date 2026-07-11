import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
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

  try {
    const first = new MemoryStore({ dbPath: dir, vectorDim: 4 });
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

    const second = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    const row = await second.getById(id);
    assert.ok(row);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.state, "archived");
    assert.equal(metadata.memory_layer, "archive");
    assert.equal(metadata.lifecycle, "archived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
