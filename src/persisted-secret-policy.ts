/**
 * Text-bearing persistence fields owned by ClawLore.
 *
 * Keep this list centralized: the read-only audit and the bounded remediation
 * planner must examine the same canonical, history, FTS, and projection
 * surfaces. Structural identifiers, timestamps, hashes, and controlled auth
 * stores are deliberately excluded.
 */
export const PERSISTED_SECRET_FIELD_MAP = {
  memory: {
    memory_truth: ["text", "metadata", "metadata_text"],
    memory_truth_fts: ["text", "metadata_text"],
    memory_items: ["content"],
    memory_revisions: ["content"],
    memory_sources: ["evidence_json"],
    memory_acl: ["policy_json"],
    memory_events: ["reason"],
    memory_fts_v2: ["content", "category"],
    memory_fts_compat_v2: ["content", "metadata_text"],
    nightly_digest_runs: ["notes"],
    task_episodes: [
      "task_goal", "user_intent", "message_ids", "journal_entry_ids",
      "tool_names", "evidence", "verification", "environment", "metadata",
    ],
    procedural_playbooks: [
      "title", "trigger", "goal", "preconditions", "steps", "pitfalls",
      "verification", "cleanup", "evidence_anchors", "related_skills",
      "environment_constraints", "reuse_policy", "metadata",
    ],
    procedural_playbooks_fts: [
      "title", "trigger", "goal", "preconditions", "steps", "pitfalls", "verification",
    ],
    playbook_versions: ["change_reason", "snapshot"],
    experience_runs: [
      "preconditions_checked", "steps_completed", "evidence", "outcome_reason", "metadata",
    ],
    experience_episodes_v2: ["parent_verification", "payload_json"],
    experience_events_v2: ["reason"],
    procedural_playbooks_v2: ["payload_json"],
    subagent_scratch_v2: ["payload_json"],
    subagent_snapshots_v2: ["payload_json"],
    knowledge_skill_promotion_drafts: [
      "title", "related_paths", "draft_path_hint", "summary", "metadata",
    ],
    experience_promotion_batches: [
      "reviewer_note", "backup_hint", "promotion_summary", "metadata",
    ],
    experience_promotion_batch_items: ["reason"],
    auto_recall_trace_events: [
      "query_preview", "reason", "filter_reasons", "memory_refs", "metadata",
    ],
    task_experience_capture_events: ["reason", "metadata"],
    memory_digest_sources: ["message_ids", "metadata"],
    projection_outbox: ["last_error"],
    vector_companion_repair_outbox: ["last_error"],
  },
  conversation: {
    conversations: ["summary", "detail", "source_detail", "tools_used", "model_used"],
    extraction_runs: ["notes"],
    decisions: ["decision", "context", "rationale", "alternatives_considered", "impact"],
    research_queries: ["query", "findings", "sources"],
    task_executions: [
      "description", "result_summary", "lessons_learned", "pitfalls_encountered",
      "files_modified", "root_cause", "fix_applied",
    ],
    entities: ["name", "description"],
  },
} as const;

export type PersistedSecretDatabaseKind = keyof typeof PERSISTED_SECRET_FIELD_MAP;

export const PERSISTED_SECRET_VECTOR_FIELDS = ["text", "metadata"] as const;
