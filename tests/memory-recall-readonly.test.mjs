import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { registerMemoryRecallTool } = jiti("../src/memory-recall-tools.ts");
const {
  filterConfidentManualRecall,
  MANUAL_RECALL_CONFIDENCE_POLICY,
} = jiti("../src/manual-recall-confidence.ts");
const { DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

function result(id, score, sources) {
  return {
    entry: {
      id,
      text: `fixture ${id}`,
      vector: [1, 0],
      category: "fact",
      scope: "agent:main",
      importance: 0.8,
      timestamp: 1,
      metadata: "{}",
    },
    score,
    sources,
  };
}

test("manual confidence policy abstains from weak vector-only matches", () => {
  const weak = [
    result("weak-a", 0.775, { vector: { score: 0.711, rank: 1 }, fused: { score: 0.775 } }),
    result("weak-b", 0.688, { vector: { score: 0.731, rank: 2 }, fused: { score: 0.688 } }),
  ];
  const rejected = filterConfidentManualRecall(weak, DEFAULT_RETRIEVAL_CONFIG);
  assert.equal(rejected.policy, MANUAL_RECALL_CONFIDENCE_POLICY);
  assert.equal(rejected.results.length, 0);
  assert.equal(rejected.rejectedCount, 2);

  const lexical = filterConfidentManualRecall([
    result("lexical", 0.7, {
      vector: { score: 0.6, rank: 1 },
      bm25: { score: 0.2, rank: 1 },
      fused: { score: 0.7 },
    }),
  ], DEFAULT_RETRIEVAL_CONFIG);
  assert.deepEqual(lexical.results.map((entry) => entry.entry.id), ["lexical"]);

  const semantic = filterConfidentManualRecall([
    result("semantic", 0.91, { vector: { score: 0.9, rank: 1 }, fused: { score: 0.91 } }),
    result("runner-up", 0.72, { vector: { score: 0.7, rank: 2 }, fused: { score: 0.72 } }),
  ], DEFAULT_RETRIEVAL_CONFIG);
  assert.deepEqual(semantic.results.map((entry) => entry.entry.id), ["semantic"]);
});

test("memory_recall is observation-only and never patches retrieved metadata", async () => {
  let patches = 0;
  const tools = new Map();
  const candidates = [result("read-only-memory", 0.9, {
    vector: { score: 0.88, rank: 1 },
    bm25: { score: 0.4, rank: 1 },
    fused: { score: 0.9 },
  })];
  const retriever = {
    async retrieve() { return candidates; },
    getConfig() { return DEFAULT_RETRIEVAL_CONFIG; },
  };
  const context = {
    retriever,
    store: {
      async patchMetadata() {
        patches += 1;
        throw new Error("manual recall attempted a write");
      },
    },
    scopeManager: {
      getDefaultScope: (agentId) => `agent:${agentId}`,
      getScopeFilter: (agentId) => [`agent:${agentId}`],
      isAccessible: (scope, agentId) => scope === `agent:${agentId}`,
    },
    principalIsolation: { enabled: false },
  };
  registerMemoryRecallTool({
    registerTool(factory, meta) {
      tools.set(meta.name, factory({ agentId: "main" }));
    },
  }, context);

  const response = await tools.get("memory_recall").execute(
    "call",
    { query: "release verification" },
    new AbortController().signal,
    undefined,
    { agentId: "main" },
  );
  assert.equal(response.details.count, 1);
  assert.equal(response.details.readOnly, true);
  assert.equal(response.details.feedbackApplied, false);
  assert.equal(patches, 0);

  retriever.retrieve = async () => [
    result("weak-a", 0.775, { vector: { score: 0.711, rank: 1 }, fused: { score: 0.775 } }),
    result("weak-b", 0.688, { vector: { score: 0.731, rank: 2 }, fused: { score: 0.688 } }),
  ];
  const noAnswer = await tools.get("memory_recall").execute(
    "call-2",
    { query: "zzzxqv qqqnonexistent" },
    new AbortController().signal,
    undefined,
    { agentId: "main" },
  );
  assert.equal(noAnswer.details.count, 0);
  assert.equal(noAnswer.details.confidenceRejected, 2);
  assert.equal(noAnswer.details.readOnly, true);
  assert.equal(patches, 0);
});
