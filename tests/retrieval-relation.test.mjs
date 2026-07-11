import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function entry(id, text, metadataPatch = {}) {
  return {
    id,
    text,
    vector: [],
    category: "fact",
    scope: "agent:main",
    importance: 1,
    timestamp: Date.now(),
    metadata: stringifySmartMetadata(buildSmartMetadata({ text, category: "fact", importance: 1 }, metadataPatch)),
  };
}

test("relation evidence penalizes conflict-review memories without expanding scope", async () => {
  const conflicted = entry(
    "conflicted",
    "Project Phoenix deploy command is not uv run deploy.",
    {
      needs_conflict_review: true,
      conflict_review_count: 1,
      relation_types: ["contradicts"],
      relations: [{ type: "contradicts", targetId: "older" }],
    },
  );
  const clean = entry(
    "clean",
    "Project Phoenix deploy command is uv run deploy.",
    {
      relation_types: ["supported_by"],
      relations: [{ type: "supported_by", targetId: "evidence" }],
    },
  );
  const store = {
    hasFtsSupport: true,
    vectorSearch: async (_vector, _limit, _minScore, scopeFilter) => {
      assert.deepEqual(scopeFilter, ["agent:main"]);
      return [
        { entry: conflicted, score: 0.8 },
        { entry: clean, score: 0.79 },
      ];
    },
  };
  const embedder = {
    embedQuery: async () => [0.1, 0.2, 0.3],
  };
  const retriever = new MemoryRetriever(
    store,
    embedder,
    {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      hardMinScore: 0,
      filterNoise: false,
      recencyWeight: 0,
      lengthNormAnchor: 0,
      timeDecayHalfLifeDays: 0,
      rerank: "none",
    },
  );

  const { results, trace } = await retriever.retrieveWithTrace({
    query: "Project Phoenix deploy command",
    limit: 2,
    scopeFilter: ["agent:main"],
    source: "manual",
  });

  assert.equal(results[0].entry.id, "clean");
  assert.equal(results[1].entry.id, "conflicted");
  assert.ok(results[1].sources.relation.adjustment < 0);
  assert.ok(results[1].sources.relation.reasons.includes("conflict_review_penalty"));
  assert.ok(trace.stages.some((stage) => stage.name === "relation_evidence"));
});
