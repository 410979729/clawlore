import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const benchmarkArgs = process.argv.slice(2);
const summaryOnly = benchmarkArgs.includes("--summary");
const casesPath = benchmarkArgs.find((arg) => !arg.startsWith("--")) || "benchmarks/golden-recall-cases.json";

function tokenize(text) {
  return [...String(text || "").toLowerCase().matchAll(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g)]
    .map((match) => match[0])
    .filter(Boolean);
}

function buildFtsQuery(query) {
  const seen = new Set();
  const tokens = [];
  for (const token of tokenize(query)) {
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(`"${token.replaceAll('"', '""')}"`);
    if (tokens.length >= 12) break;
  }
  return tokens.join(" OR ");
}

function isActive(metadataRaw) {
  try {
    const metadata = JSON.parse(metadataRaw || "{}");
    const state = String(metadata.state || "").toLowerCase();
    const layer = String(metadata.memory_layer || "").toLowerCase();
    const lifecycle = String(metadata.lifecycle || "").toLowerCase();
    const invalidatedAt = Number(metadata.invalidated_at ?? 0);
    return (
      state !== "archived" &&
      layer !== "archive" &&
      lifecycle !== "archived" &&
      (!Number.isFinite(invalidatedAt) || invalidatedAt <= 0 || invalidatedAt > Date.now())
    );
  } catch {
    return true;
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

function search(db, query, limit = 5, scopeFilter) {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return {
      rows: [],
      trace: [
        { stage: "query_parse", input: 0, output: 0, dropped: 0 },
      ],
      filters: { scopeFiltered: 0, inactiveFiltered: 0 },
    };
  }
  const rows = db.prepare(`
    SELECT m.id, m.text, m.metadata, m.scope, bm25(memory_truth_fts) AS score
    FROM memory_truth_fts
    JOIN memory_truth AS m ON m.id = memory_truth_fts.memory_id
    WHERE memory_truth_fts MATCH ?
    ORDER BY score ASC
    LIMIT ?
  `).all(ftsQuery, Math.max(limit, 20));
  const scopeSet = Array.isArray(scopeFilter) && scopeFilter.length > 0
    ? new Set(scopeFilter)
    : null;
  const scopeFilteredRows = scopeSet
    ? rows.filter((row) => scopeSet.has(row.scope))
    : rows;
  const activeRows = scopeFilteredRows.filter((row) => isActive(row.metadata));
  const finalRows = activeRows.slice(0, limit);
  return {
    rows: finalRows,
    trace: [
      { stage: "fts_candidates", input: 0, output: rows.length, dropped: 0 },
      {
        stage: "scope_filter",
        input: rows.length,
        output: scopeFilteredRows.length,
        dropped: rows.length - scopeFilteredRows.length,
      },
      {
        stage: "active_filter",
        input: scopeFilteredRows.length,
        output: activeRows.length,
        dropped: scopeFilteredRows.length - activeRows.length,
      },
      {
        stage: "final_limit",
        input: activeRows.length,
        output: finalRows.length,
        dropped: Math.max(0, activeRows.length - finalRows.length),
      },
    ],
    filters: {
      scopeFiltered: rows.length - scopeFilteredRows.length,
      inactiveFiltered: scopeFilteredRows.length - activeRows.length,
    },
  };
}

const fixture = JSON.parse(await readFile(casesPath, "utf8"));
const dbPath = join(tmpdir(), `clawlore-golden-${randomUUID()}.sqlite3`);
const db = new DatabaseSync(dbPath);
try {
  db.exec(`
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0,
      timestamp REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      metadata_text TEXT NOT NULL DEFAULT '',
      updated_at REAL NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, text, metadata_text);
  `);
  for (const item of fixture.setup || []) {
    db.prepare(`
      INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
      VALUES (?, ?, ?, ?, 0.8, 1, ?, '', 1)
    `).run(item.id, item.text, item.category || "other", item.scope || "agent:main", JSON.stringify(item.metadata || {}));
    db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, '')").run(item.id, item.text);
  }

  const results = [];
  const latencies = [];
  let expectedTotal = 0;
  let expectedHits = 0;
  let topKPasses = 0;
  let forbiddenViolations = 0;
  let reciprocalRankTotal = 0;
  let ndcgTotal = 0;
  let totalRetrieved = 0;
  let crossScopeLeakage = 0;
  const promptTokenEstimates = [];
  const laneMetrics = new Map();
  let promptBudgetCases = 0;
  let promptBudgetHits = 0;
  let promptBudgetExceeded = 0;
  const filterCounts = {
    scopeFiltered: 0,
    inactiveFiltered: 0,
  };
  for (const testCase of fixture.cases || []) {
    const started = Date.now();
    const resultLimit = Math.max(1, Math.min(20, Number(testCase.limit ?? 10) || 10));
    const { rows, trace, filters } = search(db, testCase.query, resultLimit, testCase.scope_filter);
    const latencyMs = Date.now() - started;
    latencies.push(latencyMs);
    filterCounts.scopeFiltered += filters.scopeFiltered;
    filterCounts.inactiveFiltered += filters.inactiveFiltered;
    const ids = rows.map((row) => row.id);
    totalRetrieved += rows.length;
    const allowedScopes = Array.isArray(testCase.scope_filter) && testCase.scope_filter.length > 0
      ? new Set(testCase.scope_filter)
      : null;
    const caseScopeLeakage = allowedScopes
      ? rows.filter((row) => !allowedScopes.has(row.scope)).length
      : 0;
    crossScopeLeakage += caseScopeLeakage;
    assert.equal(caseScopeLeakage, 0, `${testCase.name}: cross-scope result returned`);
    const expectedIds = testCase.expected_ids || [];
    expectedTotal += expectedIds.length;
    const missingExpectedIds = [];
    const forbiddenIds = testCase.forbidden_ids || [];
    const caseForbiddenViolations = [];
    let caseTopKPass = expectedIds.length > 0;
    for (const id of expectedIds) {
      assert.ok(ids.includes(id), `${testCase.name}: expected ${id}, got ${ids.join(", ")}`);
      expectedHits++;
      const rank = ids.indexOf(id) + 1;
      if (testCase.min_rank) {
        assert.ok(rank <= testCase.min_rank, `${testCase.name}: ${id} rank ${rank} > ${testCase.min_rank}`);
        if (rank > testCase.min_rank) caseTopKPass = false;
      }
      if (!ids.includes(id)) missingExpectedIds.push(id);
    }
    const expectedRanks = expectedIds
      .map((id) => ids.indexOf(id) + 1)
      .filter((rank) => rank > 0)
      .sort((a, b) => a - b);
    const reciprocalRank = expectedRanks.length > 0 ? 1 / expectedRanks[0] : 0;
    const dcg = expectedRanks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
    const idealDcg = expectedIds.reduce((sum, _id, index) => sum + 1 / Math.log2(index + 2), 0);
    const ndcg = idealDcg > 0 ? dcg / idealDcg : 1;
    reciprocalRankTotal += reciprocalRank;
    ndcgTotal += ndcg;
    if (caseTopKPass) topKPasses++;
    for (const id of forbiddenIds) {
      if (ids.includes(id)) caseForbiddenViolations.push(id);
      assert.ok(!ids.includes(id), `${testCase.name}: forbidden ${id} appeared in ${ids.join(", ")}`);
    }
    forbiddenViolations += caseForbiddenViolations.length;
    const promptChars = rows.reduce((sum, row) => sum + String(row.text || "").length, 0);
    const promptTokenEstimate = Math.ceil(promptChars / 4);
    promptTokenEstimates.push(promptTokenEstimate);
    const maxPromptChars = Number(testCase.max_prompt_chars ?? 0);
    let promptBudgetHit = false;
    if (Number.isFinite(maxPromptChars) && maxPromptChars > 0) {
      promptBudgetCases++;
      promptBudgetHit = promptChars <= maxPromptChars;
      if (promptBudgetHit) {
        promptBudgetHits++;
      } else {
        promptBudgetExceeded++;
      }
      assert.ok(promptBudgetHit, `${testCase.name}: prompt chars ${promptChars} > ${maxPromptChars}`);
    }
    const lane = String(testCase.lane || "unclassified");
    const laneMetric = laneMetrics.get(lane) || {
      cases: 0,
      expected: 0,
      hits: 0,
      reciprocalRankTotal: 0,
      ndcgTotal: 0,
      forbiddenViolations: 0,
      crossScopeLeakage: 0,
    };
    laneMetric.cases++;
    laneMetric.expected += expectedIds.length;
    laneMetric.hits += expectedRanks.length;
    laneMetric.reciprocalRankTotal += reciprocalRank;
    laneMetric.ndcgTotal += ndcg;
    laneMetric.forbiddenViolations += caseForbiddenViolations.length;
    laneMetric.crossScopeLeakage += caseScopeLeakage;
    laneMetrics.set(lane, laneMetric);
    results.push({
      name: testCase.name,
      lane,
      ids,
      expected_ids: expectedIds,
      missing_expected_ids: missingExpectedIds,
      forbidden_ids: forbiddenIds,
      forbidden_violations: caseForbiddenViolations,
      latency_ms: latencyMs,
      prompt_chars: promptChars,
      prompt_token_estimate: promptTokenEstimate,
      max_prompt_chars: maxPromptChars || undefined,
      prompt_budget_hit: maxPromptChars > 0 ? promptBudgetHit : undefined,
      trace,
    });
  }

  const totalCases = (fixture.cases || []).length;
  const laneSummary = Object.fromEntries([...laneMetrics.entries()].map(([lane, metric]) => [lane, {
    cases: metric.cases,
    recall: metric.expected === 0 ? 1 : metric.hits / metric.expected,
    mrr: metric.cases === 0 ? 1 : metric.reciprocalRankTotal / metric.cases,
    ndcgAtK: metric.cases === 0 ? 1 : metric.ndcgTotal / metric.cases,
    forbiddenViolations: metric.forbiddenViolations,
    crossScopeLeakage: metric.crossScopeLeakage,
  }]));
  const report = {
    ok: true,
    name: fixture.name,
    summary: {
      totalCases,
      expectedIds: expectedTotal,
      expectedHits,
      knownAnswerRecall: expectedTotal === 0 ? 1 : expectedHits / expectedTotal,
      topKAccuracy: totalCases === 0 ? 1 : topKPasses / totalCases,
      mrr: totalCases === 0 ? 1 : reciprocalRankTotal / totalCases,
      ndcgAtK: totalCases === 0 ? 1 : ndcgTotal / totalCases,
      forbiddenViolations,
      forbiddenViolationRate: totalCases === 0 ? 0 : forbiddenViolations / totalCases,
      badRecallRate: totalRetrieved === 0 ? 0 : forbiddenViolations / totalRetrieved,
      crossScopeLeakage,
      latencyMs: {
        avg: latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
      },
      promptBudget: {
        cases: promptBudgetCases,
        hitRate: promptBudgetCases === 0 ? 1 : promptBudgetHits / promptBudgetCases,
        exceeded: promptBudgetExceeded,
        tokenEstimateP50: percentile(promptTokenEstimates, 0.5),
        tokenEstimateP95: percentile(promptTokenEstimates, 0.95),
      },
      filterCounts,
      lanes: laneSummary,
    },
  };
  if (!summaryOnly) report.cases = results;
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
  await rm(dbPath, { force: true });
}
