import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { collectLanceRows, scanLanceRows } = jiti("../src/lance-row-scan.ts");

function queryFactory(source, calls) {
  return () => {
    let limit = source.length;
    let offset = 0;
    return {
      limit(value) {
        limit = value;
        return this;
      },
      offset(value) {
        offset = value;
        return this;
      },
      async toArray() {
        calls.push({ limit, offset });
        return source.slice(offset, offset + limit);
      },
    };
  };
}

test("Lance row scans use bounded pages and report complete scans", async () => {
  const calls = [];
  const consumed = [];
  const result = await scanLanceRows(
    queryFactory([0, 1, 2, 3, 4], calls),
    (rows) => consumed.push(...rows),
    { pageSize: 2, maxRows: 10 },
  );

  assert.deepEqual(consumed, [0, 1, 2, 3, 4]);
  assert.deepEqual(result, { scannedRows: 5, truncated: false });
  assert.deepEqual(calls, [
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
    { limit: 2, offset: 4 },
  ]);
});

test("Lance row scans never cross the total budget and explicitly report overflow", async () => {
  const calls = [];
  const result = await collectLanceRows(
    queryFactory([0, 1, 2, 3, 4, 5], calls),
    { pageSize: 2, maxRows: 4 },
  );

  assert.deepEqual(result.rows, [0, 1, 2, 3]);
  assert.equal(result.scannedRows, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls, [
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
    { limit: 1, offset: 4 },
  ]);
});
