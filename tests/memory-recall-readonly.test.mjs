import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { registerMemoryRecallTool } = jiti("../src/memory-recall-tools.ts");
const {
  expandedManualRecallCandidateLimit,
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

test("manual confidence uses query-to-text evidence instead of trusting inflated BM25", () => {
  const config = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    manualRecallMinScore: 0.4,
    manualRecallLexicalMinScore: 0.05,
    manualRecallVectorOnlyMinScore: 0.65,
    manualRecallMinimumTopGap: 0.05,
  };
  const wrongBm25 = result("timeout-layer", 0.83, {
    vector: { score: 0.53, rank: 1 },
    bm25: { score: 0.96, rank: 1 },
    fused: { score: 0.83 },
  });
  wrongBm25.entry.text = "turn completion timeout indicates an OpenClaw bridge failure.";
  const expected = result("no-replay", 0.53, {
    vector: { score: 0.71, rank: 2 },
    bm25: { score: 0.23, rank: 2 },
    fused: { score: 0.53 },
  });
  expected.entry.text = "若卡住的 turn 已产生副作用，不能自动重放，必须先验证当前状态。";
  const unrelated = result("unrelated", 0.44, {
    vector: { score: 0.62, rank: 3 },
    fused: { score: 0.44 },
  });
  unrelated.entry.text = "Markdown is the long-term truth layer.";

  const decision = filterConfidentManualRecall(
    [wrongBm25, expected, unrelated],
    config,
    { query: "已产生副作用的卡住 turn 能不能自动重放？", limit: 3 },
  );
  assert.deepEqual(decision.results.map((entry) => entry.entry.id), ["no-replay"]);
});

test("manual confidence accepts strong CJK lexical evidence below a broken fused score", () => {
  const expected = result("patterns", 0.454, {
    vector: { score: 0.69, rank: 1 },
    fused: { score: 0.454 },
  });
  expected.entry.text = "类型注解之后学习设计模式，例如 RLock 与延迟初始化的理由。";
  const decoy = result("typing", 0.44, {
    vector: { score: 0.66, rank: 2 },
    fused: { score: 0.44 },
  });
  decoy.entry.text = "标准库之后学习类型注解，理解为什么使用以及如何书写。";

  const decision = filterConfidentManualRecall(
    [expected, decoy],
    {
      ...DEFAULT_RETRIEVAL_CONFIG,
      manualRecallMinScore: 0.55,
      manualRecallLexicalMinScore: 0.05,
      manualRecallVectorOnlyMinScore: 0.85,
      manualRecallMinimumTopGap: 0.08,
    },
    { query: "类型注解之后学习哪些设计模式相关内容？", limit: 3 },
  );
  assert.deepEqual(decision.results.map((entry) => entry.entry.id), ["patterns"]);
});

test("manual candidate expansion is bounded and preserves the requested output limit", () => {
  assert.equal(expandedManualRecallCandidateLimit(1), 20);
  assert.equal(expandedManualRecallCandidateLimit(3), 20);
  assert.equal(expandedManualRecallCandidateLimit(6), 20);
  assert.equal(expandedManualRecallCandidateLimit(50), 20);
});

test("manual confidence prefers an entity enumeration for a who question", () => {
  const workspace = result("workspace-boundary", 0.414, {
    vector: { score: 0.63, rank: 1 },
    fused: { score: 0.414 },
  });
  workspace.entry.text = "五位协作者物理和逻辑分离，各自维护独立工作区。";
  const roster = result("roster", 0.397, {
    vector: { score: 0.60, rank: 2 },
    fused: { score: 0.397 },
  });
  roster.entry.text = "五位协作者是天枢、天璇、天姬、天权、玉衡。";

  const decision = filterConfidentManualRecall(
    [workspace, roster],
    {
      ...DEFAULT_RETRIEVAL_CONFIG,
      manualRecallMinScore: 0.4,
      manualRecallLexicalMinScore: 0.05,
      manualRecallVectorOnlyMinScore: 0.65,
      manualRecallMinimumTopGap: 0.05,
    },
    { query: "五位协作者分别是谁？", limit: 3 },
  );
  assert.deepEqual(decision.results.map((entry) => entry.entry.id), ["roster"]);
});

test("retriever contains no manual-read access reinforcement path", async () => {
  const source = await readFile(new URL("../src/retriever.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.recordAccess\s*\(/u);
  assert.doesNotMatch(source, /setAccessTracker\s*\(/u);
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
