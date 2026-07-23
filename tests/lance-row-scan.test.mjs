import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lancedb from "@lancedb/lancedb";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { collectLanceRows, scanLanceRows } = jiti("../src/lance-row-scan.ts");

function queryFactory(source, calls) {
  calls.factories += 1;
  return () => {
    calls.queries += 1;
    let limit = Number.POSITIVE_INFINITY;
    return {
      limit(value) {
        limit = value;
        calls.limits.push(value);
        return this;
      },
      async *[Symbol.asyncIterator]() {
        const snapshot = source.slice(0, limit);
        for (let offset = 0; offset < snapshot.length; offset += 2) {
          const rows = snapshot.slice(offset, offset + 2);
          yield { toArray: () => rows };
        }
      },
    };
  };
}

test("Lance row scans use bounded pages and report complete scans", async () => {
  const calls = { factories: 0, queries: 0, limits: [] };
  const consumed = [];
  const result = await scanLanceRows(
    queryFactory([0, 1, 2, 3, 4], calls),
    (rows) => consumed.push(...rows),
    { pageSize: 2, maxRows: 10 },
  );

  assert.deepEqual(consumed, [0, 1, 2, 3, 4]);
  assert.deepEqual(result, { scannedRows: 5, truncated: false });
  assert.deepEqual(calls, { factories: 1, queries: 1, limits: [11] });
});

test("Lance row scans never cross the total budget and explicitly report overflow", async () => {
  const calls = { factories: 0, queries: 0, limits: [] };
  const result = await collectLanceRows(
    queryFactory([0, 1, 2, 3, 4, 5], calls),
    { pageSize: 2, maxRows: 4 },
  );

  assert.deepEqual(result.rows, [0, 1, 2, 3]);
  assert.equal(result.scannedRows, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls, { factories: 1, queries: 1, limits: [5] });
});

test("Lance row scans keep one query snapshot when the live source changes", async () => {
  const calls = { factories: 0, queries: 0, limits: [] };
  const source = ["a", "b", "c", "d"];
  const consumed = [];
  const result = await scanLanceRows(
    queryFactory(source, calls),
    (rows) => {
      consumed.push(...rows);
      if (consumed.length === 2) source.shift();
    },
    { pageSize: 2, maxRows: 10 },
  );

  assert.deepEqual(consumed, ["a", "b", "c", "d"]);
  assert.deepEqual(source, ["b", "c", "d"]);
  assert.deepEqual(result, { scannedRows: 4, truncated: false });
  assert.deepEqual(calls, { factories: 1, queries: 1, limits: [11] });
});

test("a real Lance query does not skip a row deleted after the first consumer page", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-lance-snapshot-scan-"));
  let db;
  let table;
  try {
    db = await lancedb.connect(root);
    table = await db.createTable("memories", ["a", "b", "c", "d"].map(
      (id, index) => ({ id, text: id, vector: [index, 0] }),
    ));
    const seen = [];
    const result = await scanLanceRows(
      () => table.query().select(["id"]),
      async (rows) => {
        seen.push(...rows.map((row) => String(row.id)));
        if (seen.length === 2) await table.delete("id = 'a'");
      },
      { pageSize: 2, maxRows: 10 },
    );

    assert.deepEqual(seen.toSorted(), ["a", "b", "c", "d"]);
    assert.deepEqual(result, { scannedRows: 4, truncated: false });
    assert.deepEqual(
      (await table.query().select(["id"]).toArray())
        .map((row) => String(row.id))
        .toSorted(),
      ["b", "c", "d"],
    );
  } finally {
    await table?.close?.();
    await db?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
