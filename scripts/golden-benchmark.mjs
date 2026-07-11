import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const casesPath = process.argv[2] || "benchmarks/golden-recall-cases.json";

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
const dbPath = join(tmpdir(), `scope-recall-openclaw-golden-${randomUUID()}.sqlite3`);
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
    if (caseTopKPass) topKPasses++;
    for (const id of forbiddenIds) {
      if (ids.includes(id)) caseForbiddenViolations.push(id);
      assert.ok(!ids.includes(id), `${testCase.name}: forbidden ${id} appeared in ${ids.join(", ")}`);
    }
    forbiddenViolations += caseForbiddenViolations.length;
    const promptChars = rows.reduce((sum, row) => sum + String(row.text || "").length, 0);
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
    results.push({
      name: testCase.name,
      ids,
      expected_ids: expectedIds,
      missing_expected_ids: missingExpectedIds,
      forbidden_ids: forbiddenIds,
      forbidden_violations: caseForbiddenViolations,
      latency_ms: latencyMs,
      prompt_chars: promptChars,
      max_prompt_chars: maxPromptChars || undefined,
      prompt_budget_hit: maxPromptChars > 0 ? promptBudgetHit : undefined,
      trace,
    });
  }

  const totalCases = (fixture.cases || []).length;
  console.log(JSON.stringify({
    ok: true,
    name: fixture.name,
    summary: {
      totalCases,
      expectedIds: expectedTotal,
      expectedHits,
      knownAnswerRecall: expectedTotal === 0 ? 1 : expectedHits / expectedTotal,
      topKAccuracy: totalCases === 0 ? 1 : topKPasses / totalCases,
      forbiddenViolations,
      forbiddenViolationRate: totalCases === 0 ? 0 : forbiddenViolations / totalCases,
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
      },
      filterCounts,
    },
    cases: results,
  }, null, 2));
} finally {
  db.close();
  await rm(dbPath, { force: true });
}
