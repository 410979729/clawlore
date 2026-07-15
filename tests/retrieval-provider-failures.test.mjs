import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

function entry(id, text, vector = [0.2, 0.4, 0.6]) {
  return {
    id,
    text,
    vector,
    category: "fact",
    scope: "agent:main",
    importance: 1,
    timestamp: Date.now(),
    metadata: JSON.stringify({ state: "confirmed", memory_layer: "durable" }),
  };
}

function config(patch = {}) {
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: "hybrid",
    minScore: 0,
    hardMinScore: 0,
    filterNoise: false,
    recencyWeight: 0,
    lengthNormAnchor: 0,
    timeDecayHalfLifeDays: 0,
    rerank: "none",
    ...patch,
  };
}

for (const mode of ["hybrid", "vector"]) {
  test(`${mode} retrieval falls back to scoped BM25 when embedding fails`, async () => {
    const expected = entry(`expected-${mode}`, "release boundary recovery evidence");
    const calls = { vector: 0, bm25: 0 };
    const store = {
      hasFtsSupport: true,
      vectorSearch: async () => { calls.vector++; return []; },
      bm25Search: async (_query, _limit, scopes) => {
        calls.bm25++;
        assert.deepEqual(scopes, ["agent:main"]);
        return [{ entry: expected, score: 0.95 }];
      },
      hasId: async () => true,
    };
    const retriever = new MemoryRetriever(
      store,
      { embedQuery: async () => { throw new Error("embedding-audit-canary-secret"); } },
      config({ mode }),
    );
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const results = await retriever.retrieve({
        query: "release boundary recovery",
        limit: 3,
        scopeFilter: ["agent:main"],
        source: "manual",
      });
      assert.deepEqual(results.map((result) => result.entry.id), [expected.id]);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.vector, 0);
    assert.equal(calls.bm25, 1);
    assert.equal(warnings.join(" ").includes("embedding-audit-canary-secret"), false);
  });
}

test("cross-encoder failure returns ranked results and redacts provider errors", async () => {
  const expected = entry("expected-rerank", "release evidence", [0.2, 0.4, 0.6]);
  const store = {
    hasFtsSupport: true,
    vectorSearch: async () => [{ entry: expected, score: 0.95 }],
    bm25Search: async () => [{ entry: expected, score: 0.95 }],
    hasId: async () => true,
  };
  const retriever = new MemoryRetriever(
    store,
    { embedQuery: async () => [0.2, 0.4, 0.6] },
    config({ rerank: "cross-encoder", rerankApiKey: "test-placeholder", rerankEndpoint: "https://invalid.example/rerank" }),
  );
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async () => { throw new Error("rerank-audit-canary-secret"); };
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const results = await retriever.retrieve({ query: "release evidence", limit: 2, scopeFilter: ["agent:main"] });
    assert.equal(results[0].entry.id, expected.id);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
  assert.equal(warnings.join(" ").includes("rerank-audit-canary-secret"), false);
});
