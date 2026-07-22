#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { evaluateCaptureSafety } from "../dist/src/capture-safety.js";
import { createEmbedder } from "../dist/src/embedder.js";
import {
  expandedManualRecallCandidateLimit,
  filterConfidentManualRecall,
  MANUAL_RECALL_CONFIDENCE_POLICY,
} from "../dist/src/manual-recall-confidence.js";
import { MemoryStore } from "../dist/src/store.js";
import { DEFAULT_RETRIEVAL_CONFIG, MemoryRetriever } from "../dist/src/retriever.js";

// A wider deterministic vector keeps the offline replay stable without the
// collision rate of the old 96-bucket diagnostic embedding.
const VECTOR_DIMENSION = 384;
const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
const REQUIRED_STAGES = [
  "parallel_search",
  "rrf_fusion",
  "relation_evidence",
  "mmr_diversity",
  "secret_egress_filter",
];

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function hashToken(token) {
  let value = 0x811c9dc5;
  for (const character of token) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Stable local vectors make the evidence replayable without a provider credential. */
function deterministicEmbedding(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9_.:-]*/g) ?? [];
  const cjk = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  const features = [...words, ...cjk];
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    features.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  const vector = Array(VECTOR_DIMENSION).fill(0);
  for (const feature of features) {
    const value = hashToken(feature);
    vector[value % VECTOR_DIMENSION] += (value & 0x80000000) === 0 ? 1 : -1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function assertPrivateFile(info, label) {
  assert.equal(info.isFile(), true, `${label} must be a regular file`);
  if (process.platform !== "win32") {
    assert.equal((info.mode & 0o077) === 0, true, `${label} must be owner-only`);
  }
}

function withinRoot(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
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

function validateFixture(value) {
  assert.equal(value?.schemaVersion, 2, "real-corpus fixture schemaVersion must be 2");
  assert.equal(value?.kind, "operator-annotated-real-corpus", "real-corpus fixture kind is invalid");
  assert.ok(typeof value.name === "string" && value.name.trim(), "real-corpus fixture name is required");
  assert.ok(Array.isArray(value.source_files) && value.source_files.length > 0,
    "real-corpus fixture source_files are required");
  assert.ok(Array.isArray(value.setup) && value.setup.length >= 10 && value.setup.length <= 200,
    "real-corpus fixture requires 10-200 setup rows");
  assert.ok(Array.isArray(value.cases) && value.cases.length >= 40 && value.cases.length <= 80,
    "real-corpus fixture requires 40-80 annotated questions");
  assert.ok(value.thresholds && Number(value.thresholds.recall_at_3) >= 0.9,
    "real-corpus Recall@3 threshold must be at least 0.90");
  assert.ok(Number(value.thresholds.mrr) >= 0.85,
    "real-corpus MRR threshold must be at least 0.85");
  assert.ok(Number(value.thresholds.precision_at_3) >= 0.8,
    "real-corpus Precision@3 threshold must be at least 0.80");
  assert.ok(Number(value.thresholds.abstention_rate) >= 0.9,
    "real-corpus abstention threshold must be at least 0.90");
  assert.ok(value.retrieval && typeof value.retrieval === "object",
    "real-corpus manual recall confidence configuration is required");
  const confidenceMinimums = {
    manual_recall_min_score: 0.3,
    manual_recall_lexical_min_score: 0.01,
    manual_recall_vector_only_min_score: 0.6,
    manual_recall_minimum_top_gap: 0.03,
  };
  for (const [key, minimum] of Object.entries(confidenceMinimums)) {
    assert.ok(Number.isFinite(Number(value.retrieval[key]))
      && Number(value.retrieval[key]) >= minimum
      && Number(value.retrieval[key]) <= 1,
    `real-corpus ${key} must be between ${minimum} and 1`);
  }

  const sourceNames = new Set();
  for (const source of value.source_files) {
    assert.ok(typeof source.path === "string" && source.path.trim() && !isAbsolute(source.path),
      "real-corpus source path must be relative");
    assert.match(String(source.sha256 || ""), /^[a-f0-9]{64}$/i, "real-corpus source digest is invalid");
    assert.equal(sourceNames.has(source.path), false, "real-corpus source path is duplicated");
    sourceNames.add(source.path);
  }

  const ids = new Set();
  for (const item of value.setup) {
    assert.ok(typeof item.id === "string" && item.id.trim(), "real-corpus setup id is required");
    assert.equal(ids.has(item.id), false, "real-corpus setup id is duplicated");
    ids.add(item.id);
    assert.ok(typeof item.text === "string" && item.text.trim(), "real-corpus setup text is required");
    assert.equal(evaluateCaptureSafety(item.text).allowed, true,
      "real-corpus setup text failed capture safety");
    assert.ok(typeof item.scope === "string" && item.scope.trim(), "real-corpus setup scope is required");
    assert.equal(sourceNames.has(item.source_file), true, "real-corpus setup source is not declared");
    assert.ok(typeof item.source_anchor === "string" && item.source_anchor.trim(),
      "real-corpus setup source anchor is required");
  }

  const caseNames = new Set();
  let positiveCases = 0;
  let negativeCases = 0;
  for (const testCase of value.cases) {
    assert.equal(testCase.annotated, true, "real-corpus question annotation flag is required");
    assert.ok(typeof testCase.name === "string" && testCase.name.trim(), "real-corpus case name is required");
    assert.equal(caseNames.has(testCase.name), false, "real-corpus case name is duplicated");
    caseNames.add(testCase.name);
    assert.ok(typeof testCase.query === "string" && testCase.query.trim(), "real-corpus query is required");
    assert.equal(evaluateCaptureSafety(testCase.query).allowed, true,
      "real-corpus query failed capture safety");
    assert.ok(typeof testCase.annotation === "string" && testCase.annotation.trim(),
      "real-corpus annotation is required");
    assert.ok(Array.isArray(testCase.expected_ids), "real-corpus expected_ids are required");
    assert.ok(testCase.expected_ids.every((id) => ids.has(id)), "real-corpus expected id is unknown");
    const relevantIds = testCase.relevant_ids ?? [];
    assert.ok(Array.isArray(relevantIds) && relevantIds.every((id) => ids.has(id)),
      "real-corpus relevant id is unknown");
    assert.equal(new Set(relevantIds).size, relevantIds.length,
      "real-corpus relevant ids must be unique");
    assert.equal(relevantIds.some((id) => testCase.expected_ids.includes(id)), false,
      "real-corpus relevant ids must not duplicate required expected ids");
    if (testCase.expect_empty === true) {
      assert.equal(testCase.expected_ids.length, 0,
        "real-corpus negative case must not declare expected ids");
      assert.equal(relevantIds.length, 0,
        "real-corpus negative case must not declare relevant ids");
      negativeCases += 1;
    } else {
      assert.ok(testCase.expected_ids.length > 0,
        "real-corpus positive case requires expected ids");
      positiveCases += 1;
    }
    assert.ok(Array.isArray(testCase.scope_filter) && testCase.scope_filter.length > 0,
      "real-corpus scope_filter is required");
    assert.equal(Number(testCase.limit ?? 3), 3, "real-corpus questions must evaluate Recall@3");
    const forbidden = testCase.forbidden_ids ?? [];
    assert.ok(Array.isArray(forbidden) && forbidden.every((id) => ids.has(id)),
      "real-corpus forbidden id is unknown");
    assert.equal(forbidden.some((id) => relevantIds.includes(id)), false,
      "real-corpus relevant and forbidden ids must be disjoint");
  }
  assert.ok(positiveCases >= 30, "real-corpus fixture requires at least 30 positive cases");
  assert.ok(negativeCases >= 10, "real-corpus fixture requires at least 10 no-answer cases");
  return value;
}

async function loadFixture(fixturePath, workspaceRoot) {
  const fixtureReal = await realpath(resolve(fixturePath));
  const fixtureInfo = await stat(fixtureReal);
  assertPrivateFile(fixtureInfo, "real-corpus fixture");
  assert.ok(fixtureInfo.size > 0 && fixtureInfo.size <= MAX_FIXTURE_BYTES,
    "real-corpus fixture size is invalid");
  const fixtureBytes = await readFile(fixtureReal);
  const fixture = validateFixture(JSON.parse(fixtureBytes.toString("utf8")));
  const rootReal = await realpath(resolve(workspaceRoot));
  const sourceDigests = [];
  for (const source of fixture.source_files) {
    const sourceReal = await realpath(resolve(rootReal, source.path));
    assert.equal(withinRoot(rootReal, sourceReal), true, "real-corpus source escaped workspace root");
    const bytes = await readFile(sourceReal);
    assert.equal(hash(bytes), source.sha256, "real-corpus canonical source digest drifted");
    sourceDigests.push(hash(`${source.path}\0${source.sha256}`));
  }
  return {
    fixture,
    fixtureSha256: hash(fixtureBytes),
    sourceSetSha256: hash(JSON.stringify(sourceDigests.sort())),
  };
}

export async function evaluateRealCorpusShadow(input) {
  const loaded = await loadFixture(input.fixturePath, input.workspaceRoot);
  const fixture = loaded.fixture;
  const root = await mkdtemp(join(tmpdir(), "clawlore-real-corpus-shadow-"));
  const embedPassage = input.embedding?.embedPassage ?? (async (text) => deterministicEmbedding(text));
  const embedQuery = input.embedding?.embedQuery ?? (async (text) => deterministicEmbedding(text));
  const embeddingLabel = input.embedding?.label ?? "deterministic-hashed-token-v1";
  const liveProvider = input.embedding?.liveProvider === true;
  let store;
  try {
    const firstPassageVector = await embedPassage(fixture.setup[0].text);
    assert.ok(Array.isArray(firstPassageVector) && firstPassageVector.length > 0,
      "real-corpus passage embedding must be a non-empty numeric array");
    assert.equal(firstPassageVector.every(Number.isFinite), true,
      "real-corpus passage embedding contains a non-finite value");
    const vectorDimension = firstPassageVector.length;
    store = new MemoryStore({
      dbPath: root,
      vectorDim: vectorDimension,
      vectorBackend: "sqlite-bruteforce",
    });
    for (let index = 0; index < fixture.setup.length; index += 1) {
      const item = fixture.setup[index];
      const vector = index === 0 ? firstPassageVector : await embedPassage(item.text);
      assert.equal(vector.length, vectorDimension,
        "real-corpus passage embedding dimension drifted");
      assert.equal(vector.every(Number.isFinite), true,
        "real-corpus passage embedding contains a non-finite value");
      await store.importEntry({
        id: item.id,
        text: item.text,
        vector,
        category: productionCategory(item.category),
        scope: item.scope,
        importance: Number(item.importance ?? 0.8),
        timestamp: Number(item.timestamp ?? 1),
        metadata: JSON.stringify({ sourceSha256: hash(`${item.source_file}\0${item.source_anchor}`) }),
      });
    }

    const retrievalConfig = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "hybrid",
      minScore: 0,
      hardMinScore: 0,
      rerank: "none",
      candidatePoolSize: 60,
      recencyWeight: 0,
      lengthNormAnchor: 0,
      timeDecayHalfLifeDays: 0,
      manualRecallMinScore: Number(fixture.retrieval.manual_recall_min_score),
      manualRecallLexicalMinScore: Number(fixture.retrieval.manual_recall_lexical_min_score),
      manualRecallVectorOnlyMinScore: Number(fixture.retrieval.manual_recall_vector_only_min_score),
      manualRecallMinimumTopGap: Number(fixture.retrieval.manual_recall_minimum_top_gap),
    };
    const retriever = new MemoryRetriever(
      store,
      { embedQuery },
      retrievalConfig,
    );

    let expected = 0;
    let hits = 0;
    let relevantHits = 0;
    let reciprocalRankTotal = 0;
    let crossScopeLeakage = 0;
    let unsafeEgressViolations = 0;
    let forbiddenViolations = 0;
    let returnedResults = 0;
    let falsePositiveResults = 0;
    let positiveCases = 0;
    let negativeCases = 0;
    let negativeAbstentions = 0;
    const latencies = [];
    const stages = new Set();
    const cases = [];
    for (const testCase of fixture.cases) {
      const started = performance.now();
      const { results: candidates, trace } = await retriever.retrieveWithTrace({
        query: testCase.query,
        limit: expandedManualRecallCandidateLimit(3),
        scopeFilter: testCase.scope_filter,
        source: "manual",
      });
      latencies.push(performance.now() - started);
      for (const stage of trace.stages) stages.add(stage.name);
      const confidence = filterConfidentManualRecall(
        candidates,
        retrievalConfig,
        { query: testCase.query, limit: 3 },
      );
      const results = confidence.results;
      const ids = results.map((result) => result.entry.id);
      const expectsEmpty = testCase.expect_empty === true;
      const expectedSet = new Set(testCase.expected_ids);
      const relevantSet = new Set([...testCase.expected_ids, ...(testCase.relevant_ids ?? [])]);
      const expectedRanks = testCase.expected_ids
        .map((id) => ids.indexOf(id) + 1)
        .filter((rank) => rank > 0)
        .sort((left, right) => left - right);
      if (expectsEmpty) {
        negativeCases += 1;
        if (results.length === 0) negativeAbstentions += 1;
      } else {
        positiveCases += 1;
        expected += testCase.expected_ids.length;
        hits += expectedRanks.length;
        reciprocalRankTotal += expectedRanks.length > 0 ? 1 / expectedRanks[0] : 0;
      }
      returnedResults += results.length;
      relevantHits += ids.filter((id) => relevantSet.has(id)).length;
      const caseFalsePositives = expectsEmpty
        ? results.length
        : ids.filter((id) => !relevantSet.has(id)).length;
      falsePositiveResults += caseFalsePositives;
      const allowedScopes = new Set(testCase.scope_filter);
      const caseLeakage = results.filter((result) => !allowedScopes.has(result.entry.scope)).length;
      const caseUnsafe = results.filter((result) => !evaluateCaptureSafety(result.entry.text).allowed).length;
      const forbidden = new Set(testCase.forbidden_ids ?? []);
      const caseForbidden = ids.filter((id) => forbidden.has(id)).length;
      crossScopeLeakage += caseLeakage;
      unsafeEgressViolations += caseUnsafe;
      forbiddenViolations += caseForbidden;
      cases.push({
        caseSha256: hash(`${testCase.name}\0${testCase.query}\0${testCase.annotation}`),
        expectedSetSha256: hash(JSON.stringify([...testCase.expected_ids].sort())),
        relevantSetSha256: hash(JSON.stringify([...relevantSet].sort())),
        returnedSetSha256: hash(JSON.stringify(ids)),
        firstRelevantRank: expectedRanks[0] ?? 0,
        expectedHitsAt3: expectedRanks.length,
        expectedCount: testCase.expected_ids.length,
        relevantHitsAt3: ids.filter((id) => relevantSet.has(id)).length,
        relevantCount: relevantSet.size,
        expectsEmpty,
        returnedCount: results.length,
        confidenceRejected: confidence.rejectedCount,
        falsePositiveResults: caseFalsePositives,
        topCandidateScore: Number((candidates[0]?.score ?? 0).toFixed(6)),
        secondCandidateScore: Number((candidates[1]?.score ?? 0).toFixed(6)),
        topCandidateGap: Number(Math.max(
          0,
          (candidates[0]?.score ?? 0) - (candidates[1]?.score ?? 0),
        ).toFixed(6)),
        topCandidateVectorScore: Number((candidates[0]?.sources.vector?.score ?? 0).toFixed(6)),
        topCandidateBm25Score: Number((candidates[0]?.sources.bm25?.score ?? 0).toFixed(6)),
        returnedScoreProfile: results.map((result) => ({
          score: Number(result.score.toFixed(6)),
          vectorScore: Number((result.sources.vector?.score ?? 0).toFixed(6)),
          bm25Score: Number((result.sources.bm25?.score ?? 0).toFixed(6)),
          expected: expectedSet.has(result.entry.id),
          relevant: relevantSet.has(result.entry.id),
        })),
        crossScopeLeakage: caseLeakage,
        unsafeEgressViolations: caseUnsafe,
        forbiddenViolations: caseForbidden,
      });
    }

    const recallAt3 = expected === 0 ? 0 : hits / expected;
    const precisionAt3 = returnedResults === 0 ? 0 : relevantHits / returnedResults;
    const mrr = positiveCases === 0 ? 0 : reciprocalRankTotal / positiveCases;
    const abstentionRate = negativeCases === 0 ? 0 : negativeAbstentions / negativeCases;
    const missingStages = REQUIRED_STAGES.filter((stage) => !stages.has(stage));
    const thresholds = {
      recallAt3: Number(fixture.thresholds.recall_at_3),
      mrr: Number(fixture.thresholds.mrr),
      precisionAt3: Number(fixture.thresholds.precision_at_3),
      abstentionRate: Number(fixture.thresholds.abstention_rate),
      maximumFalsePositiveResults: Number(fixture.thresholds.maximum_false_positive_results ?? 0),
      maximumCrossScopeLeakage: Number(fixture.thresholds.maximum_cross_scope_leakage ?? 0),
      maximumUnsafeEgressViolations: Number(fixture.thresholds.maximum_unsafe_egress_violations ?? 0),
      maximumForbiddenViolations: Number(fixture.thresholds.maximum_forbidden_violations ?? 0),
    };
    const blockers = [];
    if (recallAt3 < thresholds.recallAt3) blockers.push("recall_at_3_below_threshold");
    if (mrr < thresholds.mrr) blockers.push("mrr_below_threshold");
    if (precisionAt3 < thresholds.precisionAt3) blockers.push("precision_at_3_below_threshold");
    if (abstentionRate < thresholds.abstentionRate) blockers.push("abstention_rate_below_threshold");
    if (falsePositiveResults > thresholds.maximumFalsePositiveResults) blockers.push("false_positive_result");
    if (crossScopeLeakage > thresholds.maximumCrossScopeLeakage) blockers.push("cross_scope_leakage");
    if (unsafeEgressViolations > thresholds.maximumUnsafeEgressViolations) blockers.push("unsafe_egress");
    if (forbiddenViolations > thresholds.maximumForbiddenViolations) blockers.push("forbidden_result");
    if (missingStages.length > 0) blockers.push("retrieval_stage_not_exercised");
    return {
      schemaVersion: 2,
      phase: "clawlore-real-corpus-shadow-benchmark",
      evaluatedAt: new Date().toISOString(),
      status: blockers.length === 0 ? "pass" : "fail",
      readOnly: true,
      emitsMemoryContent: false,
      emitsQueryContent: false,
      emitsRawIdentifiers: false,
      fixtureSha256: loaded.fixtureSha256,
      sourceSetSha256: loaded.sourceSetSha256,
      corpus: {
        setupRows: fixture.setup.length,
        questionCount: fixture.cases.length,
        positiveCases,
        negativeCases,
        canonicalSourceFiles: fixture.source_files.length,
        embedding: embeddingLabel,
        embeddingDimensions: vectorDimension,
        liveProvider,
        retrieval: "MemoryRetriever/hybrid",
        manualConfidencePolicy: MANUAL_RECALL_CONFIDENCE_POLICY,
        scopeFiltered: true,
      },
      metrics: {
        RecallAt3: recallAt3,
        PrecisionAt3: precisionAt3,
        MRR: mrr,
        abstentionRate,
        falsePositiveResults,
        crossScopeLeakage,
        unsafeEgressViolations,
        forbiddenViolations,
        latencyMs: {
          p50: Number(percentile(latencies, 0.5).toFixed(3)),
          p95: Number(percentile(latencies, 0.95).toFixed(3)),
          max: Number(Math.max(...latencies, 0).toFixed(3)),
        },
        stageCoverage: [...stages].sort(),
      },
      thresholds,
      cases,
      decision: {
        shadowRetrievalQualityReady: blockers.length === 0,
        liveProviderSemanticReady: liveProvider && blockers.length === 0,
        authorizesRuntimeChange: false,
        authorizesCandidatePromotion: false,
        authorizesAutomaticRecall: false,
        limitations: [
          ...(!liveProvider
            ? ["offline_deterministic_embedding_does_not_replace_live_provider_semantic_validation"]
            : []),
          "fixture_candidates_are_operator_annotated_and_not_promoted_memory",
        ],
        blockers,
      },
    };
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function resolveEvaluationEmbedding(args) {
  if (!args["embedding-provider"]) return undefined;
  const provider = args["embedding-provider"];
  assert.ok(["openai-compatible", "azure-openai", "minimax"].includes(provider),
    "unsupported live embedding provider");
  assert.ok(args["embedding-model"], "--embedding-model is required for live provider evaluation");
  assert.ok(args["embedding-api-key-file"],
    "--embedding-api-key-file is required for live provider evaluation");
  const keyPath = await realpath(resolve(args["embedding-api-key-file"]));
  const keyInfo = await stat(keyPath);
  assertPrivateFile(keyInfo, "embedding API key file");
  const apiKey = (await readFile(keyPath, "utf8")).trim();
  assert.ok(apiKey && !/[\r\n]/u.test(apiKey), "embedding API key file must contain one non-empty line");
  const dimensions = args["embedding-dimensions"] == null
    ? undefined
    : Number(args["embedding-dimensions"]);
  if (dimensions !== undefined) {
    assert.ok(Number.isSafeInteger(dimensions) && dimensions > 0,
      "--embedding-dimensions must be a positive integer");
  }
  const embedder = createEmbedder({
    provider,
    apiKey,
    model: args["embedding-model"],
    baseURL: args["embedding-base-url"],
    dimensions,
  });
  const probe = await embedder.test?.();
  assert.equal(probe?.success, true, "live embedding provider probe failed");
  return {
    embedPassage: (text) => embedder.embedPassage(text),
    embedQuery: (text) => embedder.embedQuery(text),
    label: `live-provider:${provider}:${args["embedding-model"]}`,
    liveProvider: true,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument: ${token ?? ""}`);
    }
    args[token.slice(2)] = value;
  }
  for (const required of ["fixture", "workspace", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const embedding = await resolveEvaluationEmbedding(args);
  const report = await evaluateRealCorpusShadow({
    fixturePath: resolve(args.fixture),
    workspaceRoot: resolve(args.workspace),
    embedding,
  });
  const receiptPath = resolve(args.receipt);
  await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    RecallAt3: report.metrics.RecallAt3,
    PrecisionAt3: report.metrics.PrecisionAt3,
    MRR: report.metrics.MRR,
    abstentionRate: report.metrics.abstentionRate,
    falsePositiveResults: report.metrics.falsePositiveResults,
    liveProviderSemanticReady: report.decision.liveProviderSemanticReady,
    crossScopeLeakage: report.metrics.crossScopeLeakage,
    unsafeEgressViolations: report.metrics.unsafeEgressViolations,
    blockers: report.decision.blockers,
  })}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  await main();
}
