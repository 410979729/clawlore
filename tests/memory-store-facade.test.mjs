import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");

test("MemoryStore delegates truth, retrieval, projection, and transaction ports", async () => {
  const calls = [];
  const entry = {
    id: "memory-1",
    text: "delegated",
    vector: [1, 0],
    category: "fact",
    scope: "agent:test",
    importance: 0.8,
    timestamp: 1,
    metadata: "{}",
  };
  const ports = new Proxy({
    dbPath: "/isolated/facade-test",
    hasFtsSupport: true,
    lastFtsError: null,
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return async (...args) => {
        calls.push([property, args]);
        if (property === "store") return entry;
        if (property === "vectorSearch") return [{ entry, score: 0.9 }];
        if (property === "rebuildFtsIndex") return { success: true };
        return undefined;
      };
    },
  });

  const store = new MemoryStore({ dbPath: "/must-not-open", vectorDim: 2 }, ports);
  assert.equal(store.dbPath, "/isolated/facade-test");
  assert.equal(store.hasFtsSupport, true);
  assert.deepEqual(await store.store({ ...entry, id: undefined, timestamp: undefined }), entry);
  assert.equal((await store.vectorSearch([1, 0]))[0].score, 0.9);
  assert.deepEqual(await store.rebuildFtsIndex(), { success: true });
  await store.close();
  assert.deepEqual(calls.map(([name]) => name), ["store", "vectorSearch", "rebuildFtsIndex", "close"]);
});
