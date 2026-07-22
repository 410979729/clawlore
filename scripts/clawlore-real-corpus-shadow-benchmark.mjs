#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { evaluateCaptureSafety } from "../dist/src/capture-safety.js";
import { MemoryStore } from "../dist/src/store.js";
import { DEFAULT_RETRIEVAL_CONFIG, MemoryRetriever } from "../dist/src/retriever.js";

const VECTOR_DIMENSION = 96;
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
  assert.equal(value?.schemaVersion, 1, "real-corpus fixture schemaVersion must be 1");
  assert.equal(value?.kind, "operator-annotated-real-corpus", "real-corpus fixture kind is invalid");
  assert.ok(typeof value.name === "string" && value.name.trim(), "real-corpus fixture name is required");
  assert.ok(Array.isArray(value.source_files) && value.source_files.length > 0,
    "real-corpus fixture source_files are required");
  assert.ok(Array.isArray(value.setup) && value.setup.length >= 10 && value.setup.length <= 200,
    "real-corpus fixture requires 10-200 setup rows");
  assert.ok(Array.isArray(value.cases) && value.cases.length >= 30 && value.cases.length <= 50,
    "real-corpus fixture requires 30-50 annotated questions");
  assert.ok(value.thresholds && Number(value.thresholds.recall_at_3) >= 0.9,
    "real-corpus Recall@3 threshold must be at least 0.90");
  assert.ok(Number(value.thresholds.mrr) >= 0.85,
    "real-corpus MRR threshold must be at least 0.85");

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
    assert.ok(Array.isArray(testCase.expected_ids) && testCase.expected_ids.length > 0,
      "real-corpus expected_ids are required");
    assert.ok(testCase.expected_ids.every((id) => ids.has(id)), "real-corpus expected id is unknown");
    assert.ok(Array.isArray(testCase.scope_filter) && testCase.scope_filter.length > 0,
      "real-corpus scope_filter is required");
    assert.equal(Number(testCase.limit ?? 3), 3, "real-corpus questions must evaluate Recall@3");
    const forbidden = testCase.forbidden_ids ?? [];
    assert.ok(Array.isArray(forbidden) && forbidden.every((id) => ids.has(id)),
      "real-corpus forbidden id is unknown");
  }
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
        scope: item.scope,
        importance: Number(item.importance ?? 0.8),
        timestamp: Number(item.timestamp ?? 1),
        metadata: JSON.stringify({ sourceSha256: hash(`${item.source_file}\0${item.source_anchor}`) }),
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

    let expected = 0;
    let hits = 0;
    let reciprocalRankTotal = 0;
    let crossScopeLeakage = 0;
    let unsafeEgressViolations = 0;
    let forbiddenViolations = 0;
    const latencies = [];
    const stages = new Set();
    const cases = [];
    for (const testCase of fixture.cases) {
      const started = performance.now();
      const { results, trace } = await retriever.retrieveWithTrace({
        query: testCase.query,
        limit: 3,
        scopeFilter: testCase.scope_filter,
        source: "manual",
      });
      latencies.push(performance.now() - started);
      for (const stage of trace.stages) stages.add(stage.name);
      const ids = results.map((result) => result.entry.id);
      const expectedRanks = testCase.expected_ids
        .map((id) => ids.indexOf(id) + 1)
        .filter((rank) => rank > 0)
        .sort((left, right) => left - right);
      expected += testCase.expected_ids.length;
      hits += expectedRanks.length;
      reciprocalRankTotal += expectedRanks.length > 0 ? 1 / expectedRanks[0] : 0;
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
        returnedSetSha256: hash(JSON.stringify(ids)),
        firstRelevantRank: expectedRanks[0] ?? 0,
        expectedHitsAt3: expectedRanks.length,
        expectedCount: testCase.expected_ids.length,
        crossScopeLeakage: caseLeakage,
        unsafeEgressViolations: caseUnsafe,
        forbiddenViolations: caseForbidden,
      });
    }

    const recallAt3 = expected === 0 ? 0 : hits / expected;
    const mrr = fixture.cases.length === 0 ? 0 : reciprocalRankTotal / fixture.cases.length;
    const missingStages = REQUIRED_STAGES.filter((stage) => !stages.has(stage));
    const thresholds = {
      recallAt3: Number(fixture.thresholds.recall_at_3),
      mrr: Number(fixture.thresholds.mrr),
      maximumCrossScopeLeakage: Number(fixture.thresholds.maximum_cross_scope_leakage ?? 0),
      maximumUnsafeEgressViolations: Number(fixture.thresholds.maximum_unsafe_egress_violations ?? 0),
      maximumForbiddenViolations: Number(fixture.thresholds.maximum_forbidden_violations ?? 0),
    };
    const blockers = [];
    if (recallAt3 < thresholds.recallAt3) blockers.push("recall_at_3_below_threshold");
    if (mrr < thresholds.mrr) blockers.push("mrr_below_threshold");
    if (crossScopeLeakage > thresholds.maximumCrossScopeLeakage) blockers.push("cross_scope_leakage");
    if (unsafeEgressViolations > thresholds.maximumUnsafeEgressViolations) blockers.push("unsafe_egress");
    if (forbiddenViolations > thresholds.maximumForbiddenViolations) blockers.push("forbidden_result");
    if (missingStages.length > 0) blockers.push("retrieval_stage_not_exercised");
    return {
      schemaVersion: 1,
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
        canonicalSourceFiles: fixture.source_files.length,
        embedding: "deterministic-hashed-token-v1",
        retrieval: "MemoryRetriever/hybrid",
        scopeFiltered: true,
      },
      metrics: {
        RecallAt3: recallAt3,
        MRR: mrr,
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
        authorizesRuntimeChange: false,
        authorizesCandidatePromotion: false,
        authorizesAutomaticRecall: false,
        limitations: [
          "offline_deterministic_embedding_does_not_replace_live_provider_semantic_validation",
          "fixture_candidates_are_operator_annotated_and_not_promoted_memory",
        ],
        blockers,
      },
    };
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
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
  const report = await evaluateRealCorpusShadow({
    fixturePath: resolve(args.fixture),
    workspaceRoot: resolve(args.workspace),
  });
  const receiptPath = resolve(args.receipt);
  await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    RecallAt3: report.metrics.RecallAt3,
    MRR: report.metrics.MRR,
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

