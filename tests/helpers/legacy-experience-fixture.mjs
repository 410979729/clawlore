import { randomUUID } from "node:crypto";

/**
 * Seeds a historical unsafe episode without invoking the production write
 * policy. This is intentionally test-only so governance and migration code can
 * continue proving that pre-policy rows remain quarantined and redacted.
 */
export function insertLegacyUnsafeTaskEpisode(db, overrides = {}) {
  const row = {
    id: randomUUID(),
    scope_id: "agent:main",
    shared_scope_id: "",
    session_id: "legacy-unsafe-session",
    task_class: "credential_adjacent",
    task_goal: "legacy unsafe task episode",
    user_intent: "",
    status: "completed",
    outcome: "success",
    started_at: "2026-07-01T00:00:00.000Z",
    ended_at: "2026-07-01T00:01:00.000Z",
    message_ids: [],
    journal_entry_ids: [],
    tool_names: [],
    evidence: [],
    verification: [],
    environment: {},
    metadata: {},
    ...overrides,
  };
  db.prepare(`INSERT INTO task_episodes (
    id,scope_id,shared_scope_id,session_id,task_class,task_goal,user_intent,
    status,outcome,started_at,ended_at,message_ids,journal_entry_ids,tool_names,
    evidence,verification,environment,metadata
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,
    row.scope_id,
    row.shared_scope_id,
    row.session_id,
    row.task_class,
    row.task_goal,
    row.user_intent,
    row.status,
    row.outcome,
    row.started_at,
    row.ended_at,
    JSON.stringify(row.message_ids),
    JSON.stringify(row.journal_entry_ids),
    JSON.stringify(row.tool_names),
    JSON.stringify(row.evidence),
    JSON.stringify(row.verification),
    JSON.stringify(row.environment),
    JSON.stringify(row.metadata),
  );
  return row;
}
