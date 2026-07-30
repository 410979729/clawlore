import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryStore } from "../dist/src/store.js";
import { DEFAULT_RETRIEVAL_CONFIG, MemoryRetriever } from "../dist/src/retriever.js";
import { privateTemporaryParent } from "./private-temporary-environment.mjs";

const args = process.argv.slice(2);
const summaryOnly = args.includes("--summary");
const casesPath = args.find((arg) => !arg.startsWith("--")) || "benchmarks/golden-recall-cases.json";
const VECTOR_DIMENSION = 96;

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function hashToken(token) {
  let hash = 0x811c9dc5;
  for (const character of token) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Stable local vectors keep the production-path benchmark offline and replayable. */
function deterministicEmbedding(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9_.:-]*/g) ?? [];
  const cjk = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  const features = [...words, ...cjk];
  for (let index = 0; index + 1 < cjk.length; index++) {
    features.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  const vector = Array(VECTOR_DIMENSION).fill(0);
  for (const feature of features) {
    const hash = hashToken(feature);
    vector[hash % VECTOR_DIMENSION] += (hash & 0x80000000) === 0 ? 1 : -1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function productionCategory(category) {
  switch (category) {
    case "preferences": return "preference";
    case "facts": return "fact";
    case "projects": return "entity";
    case "procedures":
    case "security": return "decision";
    default: return "other";
  }
}

const fixture = JSON.parse(await readFile(casesPath, "utf8"));
assert.ok(Array.isArray(fixture.setup), "production benchmark setup is required");
assert.ok(Array.isArray(fixture.cases), "production benchmark cases are required");
assert.ok(fixture.cases.length >= 100 && fixture.cases.length <= 300,
  "production benchmark requires 100-300 annotated cases");

const root = await mkdtemp(join(
  privateTemporaryParent(),
  ".clawlore-production-retrieval-",
));
const store = new MemoryStore({
  dbPath: root,
  vectorDim: VECTOR_DIMENSION,
  vectorBackend: "sqlite-bruteforce",
});

try {
  for (const item of fixture.setup) {
    await store.importEntry({
      id: item.id,
      text: item.text,
      vector: deterministicEmbedding(item.text),
      category: productionCategory(item.category),
      scope: item.scope || "agent:main",
      importance: 0.8,
      timestamp: 1,
      metadata: JSON.stringify(item.metadata || {}),
    });
  }

  const retriever = new MemoryRetriever(
    store,
    { embedQuery: async (query) => deterministicEmbedding(query) },
    {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "hybrid",
      minScore: 0,
      hardMinScore: 0,
      rerank: "none",
      candidatePoolSize: 60,
      recencyWeight: 0,
      lengthNormAnchor: 0,
      timeDecayHalfLifeDays: 0,
    },
  );

  const cases = [];
  const latencies = [];
  const stageCoverage = new Set();
  let expected = 0;
  let hits = 0;
  let topKPasses = 0;
  let reciprocalRankTotal = 0;
  let ndcgTotal = 0;
  let precisionTotal = 0;
  let forbiddenViolations = 0;
  let crossScopeLeakage = 0;
  let totalRetrieved = 0;
  let promptBudgetCases = 0;
  let promptBudgetHits = 0;
  const promptTokenEstimates = [];

  for (const testCase of fixture.cases) {
    assert.equal(testCase.annotated, true, `${testCase.name}: annotation flag is required`);
    assert.ok(String(testCase.annotation || "").trim(), `${testCase.name}: annotation text is required`);
    const limit = Math.max(1, Math.min(20, Number(testCase.limit ?? 5) || 5));
    const started = performance.now();
    const { results, trace } = await retriever.retrieveWithTrace({
      query: testCase.query,
      limit,
      scopeFilter: testCase.scope_filter,
      source: "manual",
    });
    const latencyMs = performance.now() - started;
    latencies.push(latencyMs);
    for (const stage of trace.stages) stageCoverage.add(stage.name);

    const ids = results.map((result) => result.entry.id);
    const expectedIds = testCase.expected_ids || [];
    const forbiddenIds = testCase.forbidden_ids || [];
    const caseHits = expectedIds.filter((id) => ids.includes(id));
    const expectedRanks = caseHits.map((id) => ids.indexOf(id) + 1).sort((a, b) => a - b);
    const rankLimit = Number(testCase.min_rank ?? limit);
    const topKPass = expectedIds.length > 0
      && expectedIds.every((id) => ids.includes(id) && ids.indexOf(id) + 1 <= rankLimit);
    expected += expectedIds.length;
    hits += caseHits.length;
    if (topKPass) topKPasses++;
    reciprocalRankTotal += expectedRanks.length > 0 ? 1 / expectedRanks[0] : 0;
    const dcg = expectedRanks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
    const idealDcg = expectedIds.reduce((sum, _id, index) => sum + 1 / Math.log2(index + 2), 0);
    ndcgTotal += idealDcg > 0 ? dcg / idealDcg : 1;
    precisionTotal += results.length > 0 ? caseHits.length / results.length : 0;
    totalRetrieved += results.length;

    for (const id of expectedIds) {
      assert.ok(ids.includes(id), `${testCase.name}: expected ${id}, got ${ids.join(", ")}`);
      assert.ok(ids.indexOf(id) + 1 <= rankLimit,
        `${testCase.name}: ${id} rank ${ids.indexOf(id) + 1} > ${rankLimit}`);
    }
    const caseForbidden = forbiddenIds.filter((id) => ids.includes(id));
    forbiddenViolations += caseForbidden.length;
    assert.deepEqual(caseForbidden, [], `${testCase.name}: forbidden result returned`);

    const allowedScopes = Array.isArray(testCase.scope_filter) && testCase.scope_filter.length > 0
      ? new Set(testCase.scope_filter)
      : null;
    const caseScopeLeakage = allowedScopes
      ? results.filter((result) => !allowedScopes.has(result.entry.scope)).length
      : 0;
    crossScopeLeakage += caseScopeLeakage;
    assert.equal(caseScopeLeakage, 0, `${testCase.name}: cross-scope result returned`);

    const promptChars = results.reduce((sum, result) => sum + result.entry.text.length, 0);
    promptTokenEstimates.push(Math.ceil(promptChars / 4));
    const maxPromptChars = Number(testCase.max_prompt_chars ?? 0);
    if (Number.isFinite(maxPromptChars) && maxPromptChars > 0) {
      promptBudgetCases++;
      const withinBudget = promptChars <= maxPromptChars;
      if (withinBudget) promptBudgetHits++;
      assert.ok(withinBudget, `${testCase.name}: prompt chars ${promptChars} > ${maxPromptChars}`);
    }

    if (!summaryOnly) {
      cases.push({ name: testCase.name, ids, latencyMs, trace: trace.stages.map((stage) => stage.name) });
    }
  }

  for (const stage of ["parallel_search", "rrf_fusion", "relation_evidence", "mmr_diversity", "secret_egress_filter"]) {
    assert.ok(stageCoverage.has(stage), `production retriever stage not exercised: ${stage}`);
  }

  const totalCases = fixture.cases.length;
  const report = {
    ok: true,
    benchmark: "production-memory-retriever-v1",
    fixture: fixture.name,
    configuration: {
      store: "MemoryStore/sqlite-bruteforce",
      retriever: "MemoryRetriever/hybrid",
      embedding: "deterministic-hashed-token-v1",
      setupRows: fixture.setup.length,
    },
    summary: {
      totalCases,
      RecallAtK: expected === 0 ? 1 : hits / expected,
      PrecisionAtK: totalCases === 0 ? 1 : precisionTotal / totalCases,
      MRR: totalCases === 0 ? 1 : reciprocalRankTotal / totalCases,
      nDCGAtK: totalCases === 0 ? 1 : ndcgTotal / totalCases,
      topKAccuracy: totalCases === 0 ? 1 : topKPasses / totalCases,
      badRecallRate: totalRetrieved === 0 ? 0 : forbiddenViolations / totalRetrieved,
      forbiddenViolations,
      crossScopeLeakage,
      promptBudget: {
        cases: promptBudgetCases,
        hitRate: promptBudgetCases === 0 ? 1 : promptBudgetHits / promptBudgetCases,
        tokenEstimateP50: percentile(promptTokenEstimates, 0.5),
        tokenEstimateP95: percentile(promptTokenEstimates, 0.95),
      },
      latencyMs: {
        p50: Number(percentile(latencies, 0.5).toFixed(3)),
        p95: Number(percentile(latencies, 0.95).toFixed(3)),
        max: Number(Math.max(...latencies, 0).toFixed(3)),
      },
      stageCoverage: [...stageCoverage].sort(),
    },
    ...(summaryOnly ? {} : { cases }),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
