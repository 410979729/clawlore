/**
 * Experience Kernel - Storage Layer
 *
 * Ported from Hermes scope-recall experience_store.py
 * Handles CRUD operations for task_episodes, procedural_playbooks, and experience_runs
 */
import { randomUUID } from "node:crypto";
import { validateProceduralPlaybook, ExperienceValidationError, PLAYBOOK_SCHEMA_VERSION, } from "./experience-models.js";
// ============================================================================
// Schema
// ============================================================================
export function ensureExperienceSchema(db) {
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
export function createTaskEpisode(db, params) {
    const now = new Date().toISOString();
    const episode = {
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
  `).run(episode.id, episode.scope_id, episode.shared_scope_id, episode.session_id, episode.task_class, episode.task_goal, episode.user_intent, episode.status, episode.outcome, episode.started_at, episode.ended_at, JSON.stringify(episode.message_ids), JSON.stringify(episode.journal_entry_ids), JSON.stringify(episode.tool_names), JSON.stringify(episode.evidence), JSON.stringify(episode.verification), JSON.stringify(episode.environment), JSON.stringify(episode.metadata));
    return episode;
}
export function recordTaskExperienceCaptureEvent(db, params) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
    INSERT INTO task_experience_capture_events (
      id, scope_id, session_id, agent_id, action, reason, task_class,
      memory_id, existing_memory_id, similarity, created_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.scope_id, params.session_id ?? "", params.agent_id ?? "", params.action, params.reason ?? "", params.task_class ?? "", params.memory_id ?? "", params.existing_memory_id ?? "", typeof params.similarity === "number" && Number.isFinite(params.similarity)
        ? params.similarity
        : 0, now, JSON.stringify(params.metadata ?? {}));
    return id;
}
export function updateEpisodeOutcome(db, episodeId, outcome, status) {
    const now = new Date().toISOString();
    const newStatus = status ?? (outcome === "success" ? "completed" : outcome === "failure" ? "failed" : "open");
    db.prepare(`
    UPDATE task_episodes
    SET outcome = ?, status = ?, ended_at = ?
    WHERE id = ?
  `).run(outcome, newStatus, now, episodeId);
}
export function getEpisode(db, episodeId) {
    const row = db.prepare("SELECT * FROM task_episodes WHERE id = ?").get(episodeId);
    if (!row)
        return null;
    return rowToEpisode(row);
}
export function listEpisodes(db, filters) {
    const conditions = [];
    const values = [];
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
    const rows = db.prepare(`SELECT * FROM task_episodes ${where} ORDER BY started_at DESC LIMIT ?`).all(...values, limit);
    return rows.map(rowToEpisode);
}
function rowToEpisode(row) {
    return {
        id: row.id,
        scope_id: row.scope_id,
        shared_scope_id: row.shared_scope_id ?? "",
        session_id: row.session_id,
        task_class: row.task_class ?? "",
        task_goal: row.task_goal,
        user_intent: row.user_intent ?? "",
        status: row.status,
        outcome: row.outcome,
        started_at: row.started_at,
        ended_at: row.ended_at ?? null,
        message_ids: safeJsonParse(row.message_ids, []),
        journal_entry_ids: safeJsonParse(row.journal_entry_ids, []),
        tool_names: safeJsonParse(row.tool_names, []),
        evidence: safeJsonParse(row.evidence, []),
        verification: safeJsonParse(row.verification, []),
        environment: safeJsonParse(row.environment, {}),
        metadata: safeJsonParse(row.metadata, {}),
    };
}
export function createPlaybook(db, params) {
    const validated = validateProceduralPlaybook(params.payload);
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`
    INSERT INTO procedural_playbooks (
      id, scope_id, shared_scope_id, task_class, title, trigger, goal,
      preconditions, steps, pitfalls, verification, cleanup,
      evidence_anchors, related_skills, environment_constraints, reuse_policy,
      status, confidence, created_from_episode_id, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.scope_id, params.shared_scope_id ?? "", validated.task_class, validated.title, validated.trigger, validated.goal, JSON.stringify(validated.preconditions), JSON.stringify(validated.steps), JSON.stringify(validated.pitfalls), JSON.stringify(validated.verification), JSON.stringify(validated.cleanup), JSON.stringify(params.evidence_anchors ?? []), JSON.stringify(params.related_skills ?? []), JSON.stringify(params.environment_constraints ?? {}), JSON.stringify(validated.reuse_policy), validated.status, validated.confidence, params.created_from_episode_id ?? "", now, now, JSON.stringify(params.metadata ?? {}));
    // Update FTS
    updatePlaybookFts(db, id, validated);
    // Create initial version
    createPlaybookVersion(db, id, 1, "create", "Initial creation", validated);
    return { ...validated, id, created_at: now };
}
export function getPlaybook(db, playbookId) {
    const row = db.prepare("SELECT * FROM procedural_playbooks WHERE id = ?").get(playbookId);
    if (!row)
        return null;
    return rowToPlaybook(row);
}
export function searchPlaybooks(db, filters) {
    const conditions = [];
    const values = [];
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
    }
    else {
        // Exclude quarantined and superseded by default
        conditions.push("status NOT IN ('quarantined', 'superseded')");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 20;
    if (filters.query) {
        const safeFtsQuery = buildSafeFtsQuery(filters.query);
        if (!safeFtsQuery)
            return [];
        // Use FTS for text search
        const ftsRows = db.prepare(`
      SELECT playbook_id, rank
      FROM procedural_playbooks_fts
      WHERE procedural_playbooks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeFtsQuery, limit);
        if (ftsRows.length === 0)
            return [];
        const playbookIds = ftsRows.map((r) => r.playbook_id);
        const idPlaceholders = playbookIds.map(() => "?").join(",");
        const rows = db.prepare(`
      SELECT * FROM procedural_playbooks
      WHERE id IN (${idPlaceholders}) ${conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""}
    `).all(...playbookIds, ...values);
        const scoreMap = new Map(ftsRows.map((r) => [r.playbook_id, -r.rank]));
        return rows.map((row) => {
            const playbook = rowToPlaybook(row);
            return { ...playbook, score: scoreMap.get(playbook.id) ?? 0 };
        }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    const rows = db.prepare(`SELECT * FROM procedural_playbooks ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`).all(...values, limit);
    return rows.map(rowToPlaybook);
}
function buildSafeFtsQuery(query) {
    const tokens = query
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((token) => token.trim())
        .filter((token) => token.length > 0)
        .slice(0, 16) ?? [];
    const unique = [...new Set(tokens)];
    return unique.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}
export function updatePlaybookStatus(db, playbookId, status, reason) {
    const playbook = getPlaybook(db, playbookId);
    if (!playbook) {
        throw new ExperienceValidationError(`Playbook ${playbookId} not found`);
    }
    const now = new Date().toISOString();
    const currentVersion = getLatestVersion(db, playbookId);
    db.prepare(`
    UPDATE procedural_playbooks
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(status, now, playbookId);
    createPlaybookVersion(db, playbookId, currentVersion + 1, "status_change", reason ?? `Status changed to ${status}`, playbook);
}
export function incrementPlaybookCounters(db, playbookId, outcome) {
    const column = outcome === "success" ? "success_count" : outcome === "failure" ? "failure_count" : "stale_count";
    const now = new Date().toISOString();
    db.prepare(`
    UPDATE procedural_playbooks
    SET ${column} = ${column} + 1, updated_at = ?, last_used_at = ?
    WHERE id = ?
  `).run(now, now, playbookId);
}
export function reviewPlaybook(db, params) {
    const { playbookId, action, reason = "", supersededBy = "" } = params;
    const actionToStatus = {
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
    const playbook = getPlaybook(db, playbookId);
    if (!playbook) {
        return { reviewed: false, id: playbookId, error: "not_found" };
    }
    const now = new Date().toISOString();
    const currentVersion = getLatestVersion(db, playbookId);
    const newVersion = currentVersion + 1;
    db.prepare(`
    UPDATE procedural_playbooks
    SET status = ?, superseded_by = ?, updated_at = ?
    WHERE id = ?
  `).run(status, status === "superseded" ? supersededBy : "", now, playbookId);
    createPlaybookVersion(db, playbookId, newVersion, status, reason || `Status changed to ${status}`, playbook);
    return { reviewed: true, id: playbookId, status, version: newVersion };
}
function rowToPlaybook(row) {
    return {
        id: row.id,
        schema_version: PLAYBOOK_SCHEMA_VERSION,
        task_class: row.task_class,
        title: row.title,
        trigger: row.trigger,
        goal: row.goal,
        preconditions: safeJsonParse(row.preconditions, []),
        steps: safeJsonParse(row.steps, []),
        pitfalls: safeJsonParse(row.pitfalls, []),
        verification: safeJsonParse(row.verification, []),
        cleanup: safeJsonParse(row.cleanup, []),
        reuse_policy: safeJsonParse(row.reuse_policy, {}),
        status: row.status,
        confidence: row.confidence,
        requires_operator_review: row.status !== "promoted",
    };
}
function updatePlaybookFts(db, playbookId, playbook) {
    // Remove existing FTS entry
    db.prepare("DELETE FROM procedural_playbooks_fts WHERE playbook_id = ?").run(playbookId);
    // Insert new FTS entry
    db.prepare(`
    INSERT INTO procedural_playbooks_fts (playbook_id, title, trigger, goal, preconditions, steps, pitfalls, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(playbookId, playbook.title, playbook.trigger, playbook.goal, JSON.stringify(playbook.preconditions), JSON.stringify(playbook.steps), JSON.stringify(playbook.pitfalls), JSON.stringify(playbook.verification));
}
// ============================================================================
// Playbook Versions
// ============================================================================
function getLatestVersion(db, playbookId) {
    const row = db.prepare("SELECT MAX(version) as max_version FROM playbook_versions WHERE playbook_id = ?").get(playbookId);
    return row?.max_version ?? 0;
}
function createPlaybookVersion(db, playbookId, version, changeType, changeReason, snapshot) {
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`
    INSERT INTO playbook_versions (id, playbook_id, version, change_type, change_reason, snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, playbookId, version, changeType, changeReason, JSON.stringify(snapshot), now);
}
export function getPlaybookVersions(db, playbookId) {
    const rows = db.prepare("SELECT * FROM playbook_versions WHERE playbook_id = ? ORDER BY version DESC").all(playbookId);
    return rows.map((row) => ({
        id: row.id,
        playbook_id: row.playbook_id,
        version: row.version,
        change_type: row.change_type,
        change_reason: row.change_reason ?? "",
        snapshot: safeJsonParse(row.snapshot, {}),
        created_at: row.created_at,
    }));
}
export function createExperienceRun(db, params) {
    const now = new Date().toISOString();
    const run = {
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
  `).run(run.id, run.playbook_id, run.episode_id, run.scope_id, run.decision, run.confidence_at_use, JSON.stringify(run.preconditions_checked), JSON.stringify(run.steps_completed), JSON.stringify(run.evidence), run.outcome, run.outcome_reason, run.model_name, run.tool_call_count, run.token_estimate, run.started_at, run.finished_at, JSON.stringify(run.metadata));
    return run;
}
export function finishExperienceRun(db, runId, outcome, outcomeReason) {
    const now = new Date().toISOString();
    db.prepare(`
    UPDATE experience_runs
    SET outcome = ?, outcome_reason = ?, finished_at = ?
    WHERE id = ?
  `).run(outcome, outcomeReason ?? "", now, runId);
}
export function listRunsForPlaybook(db, playbookId, limit = 20) {
    const rows = db.prepare("SELECT * FROM experience_runs WHERE playbook_id = ? ORDER BY started_at DESC LIMIT ?").all(playbookId, limit);
    return rows.map((row) => ({
        id: row.id,
        playbook_id: row.playbook_id,
        episode_id: row.episode_id ?? "",
        scope_id: row.scope_id,
        decision: row.decision,
        confidence_at_use: row.confidence_at_use,
        preconditions_checked: safeJsonParse(row.preconditions_checked, []),
        steps_completed: safeJsonParse(row.steps_completed, []),
        evidence: safeJsonParse(row.evidence, []),
        outcome: row.outcome,
        outcome_reason: row.outcome_reason ?? "",
        model_name: row.model_name ?? "",
        tool_call_count: row.tool_call_count ?? 0,
        token_estimate: row.token_estimate ?? 0,
        started_at: row.started_at,
        finished_at: row.finished_at ?? null,
        metadata: safeJsonParse(row.metadata, {}),
    }));
}
export function getExperienceStats(db, scopeId) {
    const scopeFilter = scopeId ? "WHERE scope_id = ?" : "";
    const scopeValues = scopeId ? [scopeId] : [];
    const episodeStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM task_episodes ${scopeFilter}
  `).get(...scopeValues);
    const playbookStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) as candidate,
      SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
      SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END) as promoted,
      SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) as quarantined
    FROM procedural_playbooks ${scopeFilter}
  `).get(...scopeValues);
    const runStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failure
    FROM experience_runs ${scopeFilter}
  `).get(...scopeValues);
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
function safeJsonParse(value, defaultValue) {
    if (value === null || value === undefined)
        return defaultValue;
    if (typeof value !== "string")
        return defaultValue;
    try {
        return JSON.parse(value);
    }
    catch {
        return defaultValue;
    }
}
