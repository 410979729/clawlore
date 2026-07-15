/**
 * Experience Kernel - Storage Layer
 *
 * Ported from Hermes scope-recall experience_store.py
 * Handles CRUD operations for task_episodes, procedural_playbooks, and experience_runs
 */

import { randomUUID } from "node:crypto";
import { redactSupportBundle } from "./v2/operator/support-bundle.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;
let experienceTransactionSequence = 0;

function withExperienceTransaction<T>(db: DatabaseSync, operation: () => T): T {
  const savepoint = `clawlore_experience_${++experienceTransactionSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch {}
    try { db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch {}
    throw err;
  }
}

interface ScopeClause {
  sql: string;
  params: string[];
}

function experienceScopeClause(
  scopeIds: string[] | undefined,
  scopeColumn = "scope_id",
  sharedScopeColumn?: string,
): ScopeClause {
  if (scopeIds === undefined) return { sql: "1 = 1", params: [] };
  const scopes = [...new Set(scopeIds.filter(Boolean))];
  if (scopes.length === 0) return { sql: "0 = 1", params: [] };
  const placeholders = scopes.map(() => "?").join(", ");
  if (!sharedScopeColumn) {
    return { sql: `${scopeColumn} IN (${placeholders})`, params: scopes };
  }
  return {
    sql: `(${scopeColumn} IN (${placeholders}) OR ${sharedScopeColumn} IN (${placeholders}))`,
    params: [...scopes, ...scopes],
  };
}
import {
  type ProceduralPlaybook,
  type TaskEpisode,
  type ExperienceRun,
  validateProceduralPlaybook,
  ExperienceValidationError,
  PLAYBOOK_SCHEMA_VERSION,
} from "./experience-models.js";

// ============================================================================
// Schema
// ============================================================================

export function ensureExperienceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_episodes (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      shared_scope_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      task_class TEXT NOT NULL DEFAULT '',
      task_goal TEXT NOT NULL,
      user_intent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      message_ids TEXT NOT NULL DEFAULT '[]',
      journal_entry_ids TEXT NOT NULL DEFAULT '[]',
      tool_names TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      verification TEXT NOT NULL DEFAULT '[]',
      environment TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_task_episodes_scope
      ON task_episodes(scope_id);

    CREATE INDEX IF NOT EXISTS idx_task_episodes_status
      ON task_episodes(status);

    CREATE INDEX IF NOT EXISTS idx_task_episodes_task_class
      ON task_episodes(task_class);

    CREATE TABLE IF NOT EXISTS procedural_playbooks (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      shared_scope_id TEXT NOT NULL DEFAULT '',
      task_class TEXT NOT NULL,
      title TEXT NOT NULL,
      trigger TEXT NOT NULL,
      goal TEXT NOT NULL,
      preconditions TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      pitfalls TEXT NOT NULL DEFAULT '[]',
      verification TEXT NOT NULL DEFAULT '[]',
      cleanup TEXT NOT NULL DEFAULT '[]',
      evidence_anchors TEXT NOT NULL DEFAULT '[]',
      related_skills TEXT NOT NULL DEFAULT '[]',
      environment_constraints TEXT NOT NULL DEFAULT '{}',
      reuse_policy TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'candidate',
      confidence REAL NOT NULL DEFAULT 0.50,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      stale_count INTEGER NOT NULL DEFAULT 0,
      created_from_episode_id TEXT NOT NULL DEFAULT '',
      superseded_by TEXT NOT NULL DEFAULT '',
      last_used_at TEXT,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_procedural_playbooks_scope
      ON procedural_playbooks(scope_id);

    CREATE INDEX IF NOT EXISTS idx_procedural_playbooks_status
      ON procedural_playbooks(status);

    CREATE INDEX IF NOT EXISTS idx_procedural_playbooks_task_class
      ON procedural_playbooks(task_class);

    CREATE VIRTUAL TABLE IF NOT EXISTS procedural_playbooks_fts USING fts5(
      playbook_id UNINDEXED,
      title,
      trigger,
      goal,
      preconditions,
      steps,
      pitfalls,
      verification
    );

    CREATE TABLE IF NOT EXISTS playbook_versions (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      change_reason TEXT NOT NULL DEFAULT '',
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playbook_versions_playbook
      ON playbook_versions(playbook_id);

    CREATE TABLE IF NOT EXISTS experience_runs (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      episode_id TEXT NOT NULL DEFAULT '',
      scope_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      confidence_at_use REAL NOT NULL DEFAULT 0.0,
      preconditions_checked TEXT NOT NULL DEFAULT '[]',
      steps_completed TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL DEFAULT 'unknown',
      outcome_reason TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_experience_runs_playbook
      ON experience_runs(playbook_id);

    CREATE INDEX IF NOT EXISTS idx_experience_runs_scope
      ON experience_runs(scope_id);

    CREATE TABLE IF NOT EXISTS task_experience_capture_events (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      task_class TEXT NOT NULL DEFAULT '',
      memory_id TEXT NOT NULL DEFAULT '',
      existing_memory_id TEXT NOT NULL DEFAULT '',
      similarity REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_task_experience_capture_events_scope
      ON task_experience_capture_events(scope_id);

    CREATE INDEX IF NOT EXISTS idx_task_experience_capture_events_action
      ON task_experience_capture_events(action);

    CREATE INDEX IF NOT EXISTS idx_task_experience_capture_events_reason
      ON task_experience_capture_events(reason);
  `);
}

// ============================================================================
// Task Episodes
// ============================================================================

export interface CreateEpisodeParams {
  scope_id: string;
  shared_scope_id?: string;
  session_id: string;
  task_class?: string;
  task_goal: string;
  user_intent?: string;
  status?: TaskEpisode["status"];
  outcome?: TaskEpisode["outcome"];
  message_ids?: string[];
  journal_entry_ids?: string[];
  tool_names?: string[];
  evidence?: string[];
  verification?: string[];
  environment?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function createTaskEpisode(db: DatabaseSync, params: CreateEpisodeParams): TaskEpisode {
  const now = new Date().toISOString();
  const episode: TaskEpisode = {
    id: randomUUID(),
    scope_id: params.scope_id,
    shared_scope_id: params.shared_scope_id ?? "",
    session_id: params.session_id,
    task_class: params.task_class ?? "",
    task_goal: params.task_goal,
    user_intent: params.user_intent ?? "",
    status: params.status ?? "open",
    outcome: params.outcome ?? "unknown",
    started_at: now,
    ended_at: null,
    message_ids: params.message_ids ?? [],
    journal_entry_ids: params.journal_entry_ids ?? [],
    tool_names: params.tool_names ?? [],
    evidence: params.evidence ?? [],
    verification: params.verification ?? [],
    environment: params.environment ?? {},
    metadata: params.metadata ?? {},
  };

  db.prepare(`
    INSERT INTO task_episodes (
      id, scope_id, shared_scope_id, session_id, task_class, task_goal, user_intent,
      status, outcome, started_at, ended_at, message_ids, journal_entry_ids,
      tool_names, evidence, verification, environment, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    episode.id,
    episode.scope_id,
    episode.shared_scope_id,
    episode.session_id,
    episode.task_class,
    episode.task_goal,
    episode.user_intent,
    episode.status,
    episode.outcome,
    episode.started_at,
    episode.ended_at,
    JSON.stringify(episode.message_ids),
    JSON.stringify(episode.journal_entry_ids),
    JSON.stringify(episode.tool_names),
    JSON.stringify(episode.evidence),
    JSON.stringify(episode.verification),
    JSON.stringify(episode.environment),
    JSON.stringify(episode.metadata),
  );

  return episode;
}

export interface RecordTaskExperienceCaptureEventParams {
  scope_id: string;
  session_id?: string;
  agent_id?: string;
  action: "created" | "duplicate" | "skipped";
  reason?: string;
  task_class?: string;
  memory_id?: string;
  existing_memory_id?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
}

export function recordTaskExperienceCaptureEvent(
  db: DatabaseSync,
  params: RecordTaskExperienceCaptureEventParams,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO task_experience_capture_events (
      id, scope_id, session_id, agent_id, action, reason, task_class,
      memory_id, existing_memory_id, similarity, created_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.scope_id,
    params.session_id ?? "",
    params.agent_id ?? "",
    params.action,
    params.reason ?? "",
    params.task_class ?? "",
    params.memory_id ?? "",
    params.existing_memory_id ?? "",
    typeof params.similarity === "number" && Number.isFinite(params.similarity)
      ? params.similarity
      : 0,
    now,
    JSON.stringify(params.metadata ?? {}),
  );
  return id;
}

export function updateEpisodeOutcome(
  db: DatabaseSync,
  episodeId: string,
  outcome: TaskEpisode["outcome"],
  status?: TaskEpisode["status"],
  scopeIds?: string[],
): boolean {
  const now = new Date().toISOString();
  const newStatus = status ?? (outcome === "success" ? "completed" : outcome === "failure" ? "failed" : "open");
  const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");

  const result = db.prepare(`
    UPDATE task_episodes
    SET outcome = ?, status = ?, ended_at = ?
    WHERE id = ? AND ${scope.sql}
  `).run(outcome, newStatus, now, episodeId, ...scope.params);
  return Number(result?.changes || 0) === 1;
}

export function getEpisode(db: DatabaseSync, episodeId: string, scopeIds?: string[]): TaskEpisode | null {
  const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");
  const row = db.prepare(`SELECT * FROM task_episodes WHERE id = ? AND ${scope.sql}`)
    .get(episodeId, ...scope.params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToEpisode(row);
}

export function listEpisodes(
  db: DatabaseSync,
  filters: { scope_id?: string; status?: string; task_class?: string; limit?: number },
): TaskEpisode[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.scope_id) {
    conditions.push("scope_id = ?");
    values.push(filters.scope_id);
  }
  if (filters.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.task_class) {
    conditions.push("task_class = ?");
    values.push(filters.task_class);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;

  const rows = db.prepare(
    `SELECT * FROM task_episodes ${where} ORDER BY started_at DESC LIMIT ?`,
  ).all(...values, limit) as Record<string, unknown>[];

  return rows.map(rowToEpisode);
}

function rowToEpisode(row: Record<string, unknown>): TaskEpisode {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    shared_scope_id: (row.shared_scope_id as string) ?? "",
    session_id: row.session_id as string,
    task_class: (row.task_class as string) ?? "",
    task_goal: row.task_goal as string,
    user_intent: (row.user_intent as string) ?? "",
    status: row.status as TaskEpisode["status"],
    outcome: row.outcome as TaskEpisode["outcome"],
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    message_ids: safeJsonParse(row.message_ids, []),
    journal_entry_ids: safeJsonParse(row.journal_entry_ids, []),
    tool_names: safeJsonParse(row.tool_names, []),
    evidence: safeJsonParse(row.evidence, []),
    verification: safeJsonParse(row.verification, []),
    environment: safeJsonParse(row.environment, {}),
    metadata: safeJsonParse(row.metadata, {}),
  };
}

// ============================================================================
// Procedural Playbooks
// ============================================================================

export interface CreatePlaybookParams {
  scope_id: string;
  shared_scope_id?: string;
  payload: Record<string, unknown>;
  created_from_episode_id?: string;
  evidence_anchors?: string[];
  related_skills?: string[];
  environment_constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface DurablePlaybookSnapshot extends ProceduralPlaybook {
  id: string;
  scope_id: string;
  shared_scope_id: string;
  evidence_anchors: string[];
  related_skills: string[];
  environment_constraints: Record<string, unknown>;
  success_count: number;
  failure_count: number;
  stale_count: number;
  created_from_episode_id: string;
  superseded_by: string;
  last_used_at: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export function createPlaybook(db: DatabaseSync, params: CreatePlaybookParams): DurablePlaybookSnapshot {
  const validated = validateProceduralPlaybook(params.payload);
  const now = new Date().toISOString();
  const id = randomUUID();

  const durable = withExperienceTransaction(db, () => {
    db.prepare(`
      INSERT INTO procedural_playbooks (
        id, scope_id, shared_scope_id, task_class, title, trigger, goal,
        preconditions, steps, pitfalls, verification, cleanup,
        evidence_anchors, related_skills, environment_constraints, reuse_policy,
        status, confidence, created_from_episode_id, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.scope_id,
      params.shared_scope_id ?? "",
      validated.task_class,
      validated.title,
      validated.trigger,
      validated.goal,
      JSON.stringify(validated.preconditions),
      JSON.stringify(validated.steps),
      JSON.stringify(validated.pitfalls),
      JSON.stringify(validated.verification),
      JSON.stringify(validated.cleanup),
      JSON.stringify(params.evidence_anchors ?? []),
      JSON.stringify(params.related_skills ?? []),
      JSON.stringify(params.environment_constraints ?? {}),
      JSON.stringify(validated.reuse_policy),
      validated.status,
      validated.confidence,
      params.created_from_episode_id ?? "",
      now,
      now,
      JSON.stringify(params.metadata ?? {}),
    );
    updatePlaybookFts(db, id, validated);
    const created = getPlaybook(db, id);
    if (!created) throw new Error("playbook create did not produce a durable row");
    createPlaybookVersion(db, id, 1, "create", "Initial creation", created);
    return created;
  });

  return durable;
}

export function getPlaybook(
  db: DatabaseSync,
  playbookId: string,
  scopeIds?: string[],
): DurablePlaybookSnapshot | null {
  const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");
  const row = db.prepare(`SELECT * FROM procedural_playbooks WHERE id = ? AND ${scope.sql}`)
    .get(playbookId, ...scope.params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToPlaybook(row);
}

export function searchPlaybooks(
  db: DatabaseSync,
  filters: {
    query?: string;
    scope_ids?: string[];
    task_class?: string;
    status?: string;
    limit?: number;
  },
): (ProceduralPlaybook & { id: string; score?: number })[] {
  if (Array.isArray(filters.scope_ids) && filters.scope_ids.length === 0) return [];
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.scope_ids && filters.scope_ids.length > 0) {
    const placeholders = filters.scope_ids.map(() => "?").join(",");
    conditions.push(`(scope_id IN (${placeholders}) OR shared_scope_id IN (${placeholders}))`);
    values.push(...filters.scope_ids, ...filters.scope_ids);
  }

  if (filters.task_class) {
    conditions.push("task_class = ?");
    values.push(filters.task_class);
  }

  if (filters.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  } else {
    // Exclude quarantined and superseded by default
    conditions.push("status NOT IN ('quarantined', 'superseded')");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 20;

  if (filters.query) {
    const safeFtsQuery = buildSafeFtsQuery(filters.query);
    if (!safeFtsQuery) return [];

    // Use FTS for text search
    const ftsRows = db.prepare(`
      SELECT playbook_id, rank
      FROM procedural_playbooks_fts
      WHERE procedural_playbooks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeFtsQuery, limit) as { playbook_id: string; rank: number }[];

    if (ftsRows.length === 0) return [];

    const playbookIds = ftsRows.map((r) => r.playbook_id);
    const idPlaceholders = playbookIds.map(() => "?").join(",");

    const rows = db.prepare(`
      SELECT * FROM procedural_playbooks
      WHERE id IN (${idPlaceholders}) ${conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""}
    `).all(...playbookIds, ...values) as Record<string, unknown>[];

    const scoreMap = new Map(ftsRows.map((r) => [r.playbook_id, -r.rank]));

    return rows.map((row) => {
      const playbook = rowToPlaybook(row);
      return { ...playbook, score: scoreMap.get(playbook.id) ?? 0 };
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  const rows = db.prepare(
    `SELECT * FROM procedural_playbooks ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
  ).all(...values, limit) as Record<string, unknown>[];

  return rows.map(rowToPlaybook);
}

function buildSafeFtsQuery(query: string): string {
  const tokens = query
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 16) ?? [];

  const unique = [...new Set(tokens)];
  return unique.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function updatePlaybookStatus(
  db: DatabaseSync,
  playbookId: string,
  status: string,
  reason?: string,
  scopeIds?: string[],
): void {
  const playbook = getPlaybook(db, playbookId, scopeIds);
  if (!playbook) {
    throw new ExperienceValidationError(`Playbook ${playbookId} not found`);
  }

  withExperienceTransaction(db, () => {
    const now = new Date().toISOString();
    const currentVersion = getLatestVersion(db, playbookId);
    const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");
    const updated = db.prepare(`
      UPDATE procedural_playbooks
      SET status = ?, updated_at = ?
      WHERE id = ? AND ${scope.sql}
    `).run(status, now, playbookId, ...scope.params);
    if (Number(updated?.changes || 0) !== 1) {
      throw new ExperienceValidationError(`Playbook ${playbookId} not found`);
    }
    const durable = getPlaybook(db, playbookId, scopeIds);
    if (!durable) throw new Error("playbook status update lost its durable row");
    createPlaybookVersion(
      db,
      playbookId,
      currentVersion + 1,
      "status_change",
      reason ?? `Status changed to ${status}`,
      durable,
    );
  });
}

export function incrementPlaybookCounters(
  db: DatabaseSync,
  playbookId: string,
  outcome: "success" | "failure" | "stale",
  scopeIds?: string[],
): boolean {
  const column = outcome === "success" ? "success_count" : outcome === "failure" ? "failure_count" : "stale_count";
  const now = new Date().toISOString();

  const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");
  const result = db.prepare(`
    UPDATE procedural_playbooks
    SET ${column} = ${column} + 1, updated_at = ?, last_used_at = ?
    WHERE id = ? AND ${scope.sql}
  `).run(now, now, playbookId, ...scope.params);
  return Number(result?.changes || 0) === 1;
}

export interface ReviewPlaybookParams {
  playbookId: string;
  action: "review" | "promote" | "needs_review" | "quarantine" | "supersede";
  reason?: string;
  supersededBy?: string;
  scopeIds?: string[];
}

export interface ReviewPlaybookResult {
  reviewed: boolean;
  id: string;
  status?: string;
  version?: number;
  error?: string;
}

export function reviewPlaybook(
  db: DatabaseSync,
  params: ReviewPlaybookParams,
): ReviewPlaybookResult {
  const { playbookId, action, reason = "", supersededBy = "", scopeIds } = params;

  const actionToStatus: Record<string, string> = {
    review: "reviewed",
    reviewed: "reviewed",
    promote: "promoted",
    promoted: "promoted",
    needs_review: "needs_review",
    quarantine: "quarantined",
    quarantined: "quarantined",
    supersede: "superseded",
    superseded: "superseded",
  };

  const status = actionToStatus[action.toLowerCase()];
  if (!status) {
    return { reviewed: false, id: playbookId, error: "unsupported_review_action" };
  }

  const playbook = getPlaybook(db, playbookId, scopeIds);
  if (!playbook) {
    return { reviewed: false, id: playbookId, error: "not_found" };
  }

  const newVersion = withExperienceTransaction(db, () => {
    const now = new Date().toISOString();
    const currentVersion = getLatestVersion(db, playbookId);
    const nextVersion = currentVersion + 1;
    const scope = experienceScopeClause(scopeIds, "scope_id", "shared_scope_id");
    const updated = db.prepare(`
      UPDATE procedural_playbooks
      SET status = ?, superseded_by = ?, updated_at = ?
      WHERE id = ? AND ${scope.sql}
    `).run(status, status === "superseded" ? supersededBy : "", now, playbookId, ...scope.params);
    if (Number(updated?.changes || 0) !== 1) {
      throw new Error("playbook review update did not affect exactly one row");
    }
    const durable = getPlaybook(db, playbookId, scopeIds);
    if (!durable) throw new Error("playbook review lost its durable row");
    createPlaybookVersion(db, playbookId, nextVersion, status, reason || `Status changed to ${status}`, durable);
    return nextVersion;
  });

  return { reviewed: true, id: playbookId, status, version: newVersion };
}

function rowToPlaybook(row: Record<string, unknown>): DurablePlaybookSnapshot {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    shared_scope_id: (row.shared_scope_id as string) ?? "",
    superseded_by: (row.superseded_by as string) ?? "",
    schema_version: PLAYBOOK_SCHEMA_VERSION,
    task_class: row.task_class as string,
    title: row.title as string,
    trigger: row.trigger as string,
    goal: row.goal as string,
    preconditions: safeJsonParse(row.preconditions, []),
    steps: safeJsonParse(row.steps, []),
    pitfalls: safeJsonParse(row.pitfalls, []),
    verification: safeJsonParse(row.verification, []),
    cleanup: safeJsonParse(row.cleanup, []),
    evidence_anchors: safeJsonParse(row.evidence_anchors, []),
    related_skills: safeJsonParse(row.related_skills, []),
    environment_constraints: safeJsonParse(row.environment_constraints, {}),
    reuse_policy: safeJsonParse(row.reuse_policy, {}),
    status: row.status as string,
    confidence: Number(row.confidence),
    success_count: Number(row.success_count),
    failure_count: Number(row.failure_count),
    stale_count: Number(row.stale_count),
    created_from_episode_id: (row.created_from_episode_id as string) ?? "",
    last_used_at: (row.last_used_at as string | null) ?? null,
    last_verified_at: (row.last_verified_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    metadata: safeJsonParse(row.metadata, {}),
    requires_operator_review: row.status !== "promoted",
  };
}

function updatePlaybookFts(db: DatabaseSync, playbookId: string, playbook: ProceduralPlaybook): void {
  // Remove existing FTS entry
  db.prepare("DELETE FROM procedural_playbooks_fts WHERE playbook_id = ?").run(playbookId);

  // Insert new FTS entry
  db.prepare(`
    INSERT INTO procedural_playbooks_fts (playbook_id, title, trigger, goal, preconditions, steps, pitfalls, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    playbookId,
    playbook.title,
    playbook.trigger,
    playbook.goal,
    JSON.stringify(playbook.preconditions),
    JSON.stringify(playbook.steps),
    JSON.stringify(playbook.pitfalls),
    JSON.stringify(playbook.verification),
  );
}

// ============================================================================
// Playbook Versions
// ============================================================================

function getLatestVersion(db: DatabaseSync, playbookId: string): number {
  const row = db.prepare(
    "SELECT MAX(version) as max_version FROM playbook_versions WHERE playbook_id = ?",
  ).get(playbookId) as { max_version: number | null } | undefined;
  return row?.max_version ?? 0;
}

function createPlaybookVersion(
  db: DatabaseSync,
  playbookId: string,
  version: number,
  changeType: string,
  changeReason: string,
  snapshot: Record<string, unknown> | ProceduralPlaybook | (ProceduralPlaybook & { id: string }),
): void {
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO playbook_versions (id, playbook_id, version, change_type, change_reason, snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    playbookId,
    version,
    changeType,
    changeReason,
    JSON.stringify(redactSupportBundle(snapshot)),
    now,
  );
}

export function getPlaybookVersions(db: DatabaseSync, playbookId: string, scopeIds?: string[]): {
  id: string;
  playbook_id: string;
  version: number;
  change_type: string;
  change_reason: string;
  snapshot: Record<string, unknown>;
  created_at: string;
}[] {
  const scope = experienceScopeClause(scopeIds, "p.scope_id", "p.shared_scope_id");
  const rows = db.prepare(
    `
    SELECT v.*
    FROM playbook_versions v
    JOIN procedural_playbooks p ON p.id = v.playbook_id
    WHERE v.playbook_id = ? AND ${scope.sql}
    ORDER BY v.version DESC
    `,
  ).all(playbookId, ...scope.params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    playbook_id: row.playbook_id as string,
    version: row.version as number,
    change_type: row.change_type as string,
    change_reason: (row.change_reason as string) ?? "",
    snapshot: safeJsonParse(row.snapshot, {}),
    created_at: row.created_at as string,
  }));
}

// ============================================================================
// Experience Runs
// ============================================================================

export interface CreateRunParams {
  playbook_id: string;
  episode_id?: string;
  scope_id: string;
  decision: ExperienceRun["decision"];
  confidence_at_use: number;
  preconditions_checked?: string[];
  steps_completed?: number[];
  evidence?: string[];
  outcome?: ExperienceRun["outcome"];
  outcome_reason?: string;
  model_name?: string;
  tool_call_count?: number;
  token_estimate?: number;
  metadata?: Record<string, unknown>;
}

export function createExperienceRun(db: DatabaseSync, params: CreateRunParams): ExperienceRun {
  const now = new Date().toISOString();
  const run: ExperienceRun = {
    id: randomUUID(),
    playbook_id: params.playbook_id,
    episode_id: params.episode_id ?? "",
    scope_id: params.scope_id,
    decision: params.decision,
    confidence_at_use: params.confidence_at_use,
    preconditions_checked: params.preconditions_checked ?? [],
    steps_completed: params.steps_completed ?? [],
    evidence: params.evidence ?? [],
    outcome: params.outcome ?? "unknown",
    outcome_reason: params.outcome_reason ?? "",
    model_name: params.model_name ?? "",
    tool_call_count: params.tool_call_count ?? 0,
    token_estimate: params.token_estimate ?? 0,
    started_at: now,
    finished_at: null,
    metadata: params.metadata ?? {},
  };

  db.prepare(`
    INSERT INTO experience_runs (
      id, playbook_id, episode_id, scope_id, decision, confidence_at_use,
      preconditions_checked, steps_completed, evidence, outcome, outcome_reason,
      model_name, tool_call_count, token_estimate, started_at, finished_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.playbook_id,
    run.episode_id,
    run.scope_id,
    run.decision,
    run.confidence_at_use,
    JSON.stringify(run.preconditions_checked),
    JSON.stringify(run.steps_completed),
    JSON.stringify(run.evidence),
    run.outcome,
    run.outcome_reason,
    run.model_name,
    run.tool_call_count,
    run.token_estimate,
    run.started_at,
    run.finished_at,
    JSON.stringify(run.metadata),
  );

  return run;
}

export function finishExperienceRun(
  db: DatabaseSync,
  runId: string,
  outcome: ExperienceRun["outcome"],
  outcomeReason?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE experience_runs
    SET outcome = ?, outcome_reason = ?, finished_at = ?
    WHERE id = ?
  `).run(outcome, outcomeReason ?? "", now, runId);
}

export function recordPlaybookFeedbackAtomically(
  db: DatabaseSync,
  params: CreateRunParams & {
    outcome: ExperienceRun["outcome"];
    outcome_reason?: string;
    counter: "success" | "failure" | "stale";
    scope_ids?: string[];
  },
): ExperienceRun {
  return withExperienceTransaction(db, () => {
    const playbook = getPlaybook(db, params.playbook_id, params.scope_ids);
    if (!playbook) {
      throw new ExperienceValidationError(`Playbook ${params.playbook_id} not found`);
    }
    const run = createExperienceRun(db, params);
    finishExperienceRun(db, run.id, params.outcome, params.outcome_reason);
    if (!incrementPlaybookCounters(db, params.playbook_id, params.counter, params.scope_ids)) {
      throw new ExperienceValidationError(`Playbook ${params.playbook_id} not found`);
    }
    return {
      ...run,
      outcome: params.outcome,
      outcome_reason: params.outcome_reason ?? "",
      finished_at: new Date().toISOString(),
    };
  });
}

export function listRunsForPlaybook(
  db: DatabaseSync,
  playbookId: string,
  limit = 20,
  scopeIds?: string[],
): ExperienceRun[] {
  const scope = experienceScopeClause(scopeIds, "scope_id");
  const rows = db.prepare(
    `SELECT * FROM experience_runs WHERE playbook_id = ? AND ${scope.sql} ORDER BY started_at DESC LIMIT ?`,
  ).all(playbookId, ...scope.params, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    playbook_id: row.playbook_id as string,
    episode_id: (row.episode_id as string) ?? "",
    scope_id: row.scope_id as string,
    decision: row.decision as ExperienceRun["decision"],
    confidence_at_use: row.confidence_at_use as number,
    preconditions_checked: safeJsonParse(row.preconditions_checked, []),
    steps_completed: safeJsonParse(row.steps_completed, []),
    evidence: safeJsonParse(row.evidence, []),
    outcome: row.outcome as ExperienceRun["outcome"],
    outcome_reason: (row.outcome_reason as string) ?? "",
    model_name: (row.model_name as string) ?? "",
    tool_call_count: (row.tool_call_count as number) ?? 0,
    token_estimate: (row.token_estimate as number) ?? 0,
    started_at: row.started_at as string,
    finished_at: (row.finished_at as string) ?? null,
    metadata: safeJsonParse(row.metadata, {}),
  }));
}

// ============================================================================
// Stats
// ============================================================================

export interface ExperienceStats {
  episodes: {
    total: number;
    open: number;
    completed: number;
    failed: number;
  };
  playbooks: {
    total: number;
    candidate: number;
    reviewed: number;
    promoted: number;
    needs_review: number;
    quarantined: number;
  };
  runs: {
    total: number;
    success: number;
    failure: number;
  };
}

export function getExperienceStats(db: DatabaseSync, scopeIds?: string | string[]): ExperienceStats {
  const normalizedScopes = typeof scopeIds === "string" ? [scopeIds] : scopeIds;
  const scope = experienceScopeClause(normalizedScopes, "scope_id");
  const scopeFilter = `WHERE ${scope.sql}`;
  const scopeValues = scope.params;

  const episodeStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM task_episodes ${scopeFilter}
  `).get(...scopeValues) as Record<string, number>;

  const playbookStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) as candidate,
      SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
      SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END) as promoted,
      SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) as quarantined
    FROM procedural_playbooks ${scopeFilter}
  `).get(...scopeValues) as Record<string, number>;

  const runStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failure
    FROM experience_runs ${scopeFilter}
  `).get(...scopeValues) as Record<string, number>;

  return {
    episodes: {
      total: episodeStats.total ?? 0,
      open: episodeStats.open ?? 0,
      completed: episodeStats.completed ?? 0,
      failed: episodeStats.failed ?? 0,
    },
    playbooks: {
      total: playbookStats.total ?? 0,
      candidate: playbookStats.candidate ?? 0,
      reviewed: playbookStats.reviewed ?? 0,
      promoted: playbookStats.promoted ?? 0,
      needs_review: playbookStats.needs_review ?? 0,
      quarantined: playbookStats.quarantined ?? 0,
    },
    runs: {
      total: runStats.total ?? 0,
      success: runStats.success ?? 0,
      failure: runStats.failure ?? 0,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function safeJsonParse<T>(value: unknown, defaultValue: T): T {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value !== "string") return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}
