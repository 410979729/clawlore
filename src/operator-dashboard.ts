import { activeDirtyCounts } from "./governance-cleanup.js";
import { recoveryReport } from "./journal-recovery.js";
import { candidateDebtReport } from "./candidate-promotion.js";
import { digestReport } from "./digest-pipeline.js";
import { graphHygieneReport } from "./graph-hygiene.js";
import { isMemoryActiveAt, parseSmartMetadata } from "./smart-metadata.js";
import { inspectLifecycleProjection } from "./sql-lifecycle-projection.js";

type DatabaseSync = any;

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function countRows(db: DatabaseSync, table: string): number {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
  } catch {
    return 0;
  }
}

function groupedCounts(db: DatabaseSync, table: string, column: string): Record<string, number> {
  try {
    const rows = db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ key: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [String(row.key || ""), Number(row.count || 0)]));
  } catch {
    return {};
  }
}

function ftsHealth(db: DatabaseSync, tables: Set<string>): Record<string, unknown> {
  if (!tables.has("memory_truth") || !tables.has("memory_truth_fts")) {
    return { status: "missing", truth_rows: countRows(db, "memory_truth"), fts_rows: 0 };
  }
  const truthRows = countRows(db, "memory_truth");
  const ftsRows = countRows(db, "memory_truth_fts");
  const missing = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_truth AS m
    LEFT JOIN memory_truth_fts AS f ON f.memory_id = m.id
    WHERE f.memory_id IS NULL
  `).get()?.count || 0);
  const stale = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_truth_fts AS f
    LEFT JOIN memory_truth AS m ON m.id = f.memory_id
    WHERE m.id IS NULL
  `).get()?.count || 0);
  return {
    status: missing === 0 && stale === 0 ? "ok" : "needs_repair",
    truth_rows: truthRows,
    fts_rows: ftsRows,
    missing_fts_rows: missing,
    stale_fts_rows: stale,
  };
}

function experienceHealth(db: DatabaseSync, tables: Set<string>): Record<string, unknown> {
  const required = [
    "task_episodes",
    "procedural_playbooks",
    "experience_runs",
    "task_experience_capture_events",
  ];
  const missing = required.filter((name) => !tables.has(name));
  if (missing.length > 0) return { status: "not_initialized", missing_tables: missing };
  return {
    status: "ready",
    task_episodes: countRows(db, "task_episodes"),
    procedural_playbooks: countRows(db, "procedural_playbooks"),
    experience_runs: countRows(db, "experience_runs"),
    task_experience_capture_events: countRows(db, "task_experience_capture_events"),
    capture_events_by_action: groupedCounts(db, "task_experience_capture_events", "action"),
    playbooks_by_status: groupedCounts(db, "procedural_playbooks", "status"),
    runs_by_outcome: groupedCounts(db, "experience_runs", "outcome"),
  };
}

function freshnessHealth(db: DatabaseSync, tables: Set<string>): Record<string, unknown> {
  if (!tables.has("memory_truth")) {
    return { status: "missing", stale_facts: 0, live_check_needed: 0, unknown_freshness_facts: 0, samples: [] };
  }

  const rows = db.prepare(`
    SELECT id, text, category, importance, timestamp, metadata
    FROM memory_truth
    WHERE category = 'fact'
    LIMIT 1000
  `).all() as Array<{
    id: string;
    text: string;
    category: "fact";
    importance: number;
    timestamp: number;
    metadata?: string;
  }>;

  let staleFacts = 0;
  let liveCheckNeeded = 0;
  let unknownFreshnessFacts = 0;
  let debt = 0;
  const samples: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    const meta = parseSmartMetadata(row.metadata, row);
    if (!isMemoryActiveAt(meta)) continue;
    const isStale = meta.freshness_status === "stale";
    const needsLiveCheck = meta.live_check_needed === true || meta.freshness_status === "live_check_needed";
    const isUnknown = !meta.freshness_status && !meta.observed_at && !meta.valid_until;
    if (isStale) staleFacts++;
    if (needsLiveCheck) liveCheckNeeded++;
    if (isUnknown) unknownFreshnessFacts++;
    if (isStale || needsLiveCheck || isUnknown) debt++;
    if (samples.length < 10) {
      if (isStale) samples.push({ id: row.id, reason: "stale" });
      else if (needsLiveCheck) samples.push({ id: row.id, reason: "live_check_needed" });
      else if (isUnknown) samples.push({ id: row.id, reason: "unknown_freshness" });
    }
  }

  return {
    status: debt === 0 ? "ok" : "needs_review",
    debt,
    fact_rows_scanned: rows.length,
    stale_facts: staleFacts,
    live_check_needed: liveCheckNeeded,
    unknown_freshness_facts: unknownFreshnessFacts,
    samples,
  };
}

export function buildOperatorDashboard(
  db: DatabaseSync,
  options: { version?: string; vectorStatus?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  const tables = tableNames(db);
  const governanceDirtyCounts = tables.has("memory_truth") ? activeDirtyCounts(db) : {};
  const journal = recoveryReport(db, { reasonPrefixes: ["retry-exhausted:", "dead-letter:"] });
  const candidates = candidateDebtReport(db);
  const graph = graphHygieneReport(db);
  const freshness = freshnessHealth(db, tables);
  const digest = digestReport(db, { sampleLimit: 5 });
  const fts = ftsHealth(db, tables);
  const lifecycleProjection = tables.has("memory_truth")
    ? inspectLifecycleProjection(db)
    : {
      ok: false,
      status: "missing",
      reason: "memory_truth_missing",
      truthRows: 0,
      projectedRows: 0,
      stateProjectedRows: null,
      repairRequired: false,
    };
  const experience = experienceHealth(db, tables);
  const memoryRows = tables.has("memory_truth") ? countRows(db, "memory_truth") : 0;
  const activeGovernanceDirty = Object.values(governanceDirtyCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  const candidateCount = Number(candidates.candidate_count || 0);
  const digestCandidateDebt = Number(digest.candidate_debt || 0);
  const digestFailedRuns = Number(digest.failed_runs || 0);
  const dashboardOk = memoryRows > 0
    && fts.status === "ok"
    && lifecycleProjection.ok
    && activeGovernanceDirty === 0
    && journal.candidate_count === 0
    && candidateCount === 0
    && graph.status !== "needs_repair"
    && freshness.status === "ok"
    && digest.status === "ready"
    && digestCandidateDebt === 0
    && digestFailedRuns === 0
    && experience.status === "ready";
  return {
    ok: dashboardOk,
    version: options.version || "",
    summary: {
      memory_rows: memoryRows,
      fts_status: fts.status,
      lifecycle_projection_status: lifecycleProjection.status,
      governance_cleanup_candidates: activeGovernanceDirty,
      journal_recovery_status: journal.status,
      journal_replay_candidates: journal.candidate_count,
      memory_candidate_debt: candidateCount,
      graph_hygiene_status: graph.status,
      freshness_status: freshness.status,
      freshness_debt: Number(freshness.debt || 0),
      digest_status: digest.status,
      digest_candidate_debt: digestCandidateDebt,
      digest_failed_runs: digestFailedRuns,
      experience_status: experience.status,
    },
    sections: {
      fts,
      lifecycle_projection: lifecycleProjection,
      governance_cleanup: {
        active_dirty_counts: governanceDirtyCounts,
      },
      journal_recovery: journal,
      memory_candidate_promotion: candidates,
      graph_hygiene: graph,
      freshness,
      digest,
      experience,
      vector: options.vectorStatus || {},
    },
  };
}
