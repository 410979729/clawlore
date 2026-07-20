import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  ensureExperienceSchema,
  createTaskEpisode,
  createPlaybook,
} = jiti("../src/experience-store.ts");
const {
  recordAutoRecallTrace,
  listAutoRecallTraces,
} = jiti("../src/auto-recall-ledger.ts");
const { runPromotionBatch } = jiti("../src/experience-promotion-batch.ts");
const { promoteExperiences } = jiti("../src/experience-promotion.ts");
const {
  evaluateRecallScopePolicy,
  scopeIdForContext,
} = jiti("../src/scope-policy.ts");
const { buildKnowledgeSkillDrafts } = jiti("../src/knowledge-skill-bridge.ts");

function tableExists(db, name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?",
  ).get(name);
  return row?.name === name;
}

function createPlaybookPayload(overrides = {}) {
  return {
    task_class: "scope_recall_quality_check",
    title: "Scope recall quality closeout",
    trigger: "scope recall roadmap implementation",
    goal: "Close a scoped roadmap item with tests and live evidence.",
    preconditions: [{ check: "Read current roadmap and repo state" }],
    steps: [
      {
        number: 1,
        capability_class: "read_only",
        action: "Inspect current state before changing files.",
        evidence_required: "repo status and relevant source reads",
      },
      {
        number: 2,
        capability_class: "local_write",
        action: "Patch the narrow module and add tests.",
        evidence_required: "focused diff",
      },
    ],
    pitfalls: [{ note: "Do not treat dry-run commands as mutation-free unless verified." }],
    verification: ["node --test passes"],
    cleanup: ["Remove temporary artifacts."],
    reuse_policy: { scope: "same plugin workflow" },
    status: "promoted",
    confidence: 0.86,
    ...overrides,
  };
}

test("auto-recall trace ledger redacts query text and raw memory ids", () => {
  const db = new DatabaseSync(":memory:");
  const rawMemoryId = "memory-secret-raw-id-123";
  recordAutoRecallTrace(db, {
    scope_id: "agent:main",
    session_id: "session-1",
    agent_id: "main",
    channel: "telegram",
    query_source: "cached-user-message",
    query: "please inspect api_key = sk-test-not-real-123456789 and <relevant-memories>hidden</relevant-memories>",
    decision: "injected",
    reason: "selected",
    result_count: 2,
    injected_count: 1,
    memory_refs: [
      {
        memory_id: rawMemoryId,
        scope: "agent:main",
        category: "fact",
        score: 0.9,
        rank_reasons: ["bm25_rank=1"],
        filter_status: "injected",
      },
      {
        memory_id: "other-memory-id",
        scope: "custom:customer:work-pc",
        category: "decision",
        score: 0.5,
        filter_status: "suppressed",
        filter_reason: "cross_scope_review",
      },
    ],
  });

  const report = listAutoRecallTraces(db, { scope_id: "agent:main" });
  const serialized = JSON.stringify(report);
  assert.equal(report.status, "ok");
  assert.equal(report.total, 1);
  assert.equal(report.items[0].injected_count, 1);
  assert.equal(report.items[0].crossed_scope_count, 1);
  assert.match(report.items[0].query_preview, /^sha256:[a-f0-9]{16};length=\d+$/);
  assert.doesNotMatch(serialized, /sk-test-not-real/);
  assert.doesNotMatch(serialized, /please inspect/);
  assert.doesNotMatch(serialized, /memory-secret-raw-id/);
  assert.match(report.items[0].memory_refs[0].memory_ref, /^mem_[a-f0-9]{16}$/);
});

test("auto-recall optional previews and metadata reuse canonical secret redaction", () => {
  const db = new DatabaseSync(":memory:");
  const aliasSecret = "SyntheticLedgerAliasSecret123";
  const digestSecret = "SyntheticLedgerDigestSecret123";
  recordAutoRecallTrace(db, {
    scope_id: "agent:main",
    query_source: `Authorization: Digest response=\"${digestSecret}\"`,
    query: `shared: &credential ${aliasSecret}\npassword: *credential`,
    include_query_preview: true,
    decision: "skipped",
    reason: "policy review",
    metadata: {
      databasePassword: "Synthetic Metadata Secret 123",
      nested: { diagnostic: `Authorization: Digest response=\"${digestSecret}\"` },
    },
  });

  const report = listAutoRecallTraces(db, { scope_id: "agent:main" });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(aliasSecret));
  assert.doesNotMatch(serialized, new RegExp(digestSecret));
  assert.doesNotMatch(serialized, /Synthetic Metadata Secret 123/);
  assert.match(serialized, /REDACTED|redacted-secret/);
});

test("promotion batch dry-run is zero-write and apply records batch items", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-ready",
    task_class: "scope_recall_quality_check",
    task_goal: "Implement scope recall roadmap controls.",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: ["node --test tests/experience-roadmap.test.mjs passed"],
    verification: ["typecheck passed"],
    metadata: {
      promotion_eligible: true,
      reviewer_passed: true,
      promotion_review: { decision: "approved", source: "roadmap-test-reviewer" },
    },
  });

  const preview = runPromotionBatch(db, { scope_id: "agent:main", dry_run: true });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.recorded, false);
  assert.equal(preview.promotion.playbooks_created, 1);
  assert.equal(tableExists(db, "experience_promotion_batches"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM procedural_playbooks").get().count, 0);

  const applied = runPromotionBatch(db, {
    scope_id: "agent:main",
    dry_run: false,
    reviewer_note: "roadmap phase 2 apply test",
  });
  assert.equal(applied.recorded, true);
  assert.equal(applied.backup_required, true);
  assert.match(applied.backup_hint, /SQLite truth DB/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experience_promotion_batches").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experience_promotion_batch_items").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM procedural_playbooks").get().count, 1);
});

test("new promotion records use ClawLore task classes while legacy classes remain readable", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-clawlore-quality",
    task_class: "agent_verified_task",
    task_goal: "Refactor the ClawLore runtime boundary and verify the focused tests.",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: ["Focused ClawLore runtime tests passed."],
    verification: ["node --test passed"],
    metadata: {
      promotion_eligible: true,
      reviewer_passed: true,
      promotion_review: { decision: "approved", source: "roadmap-test-reviewer" },
    },
  });

  const result = promoteExperiences(db, { scope_id: "agent:main", dry_run: false });
  assert.equal(result.playbooks_created, 1);
  const playbook = db.prepare(
    "SELECT task_class, title FROM procedural_playbooks WHERE created_from_episode_id <> ''",
  ).get();
  assert.equal(playbook.task_class, "clawlore_quality_check");
  assert.equal(playbook.title, "ClawLore 质量检查经验手册");
});

test("automatic promotion requires explicit positive reviewer provenance", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const rejectedReasons = [
    "review_declined",
    "review_invalid_or_low_confidence",
    "review_parse_failure",
    "capture_safety_secret_like",
  ];
  for (const [index, reason] of rejectedReasons.entries()) {
    createTaskEpisode(db, {
      scope_id: "agent:main",
      session_id: `session-rejected-${index}`,
      task_class: "clawlore_quality_check",
      task_goal: `Rejected experience ${index}`,
      status: "completed",
      outcome: "success",
      tool_names: ["node:test"],
      evidence: ["focused test passed"],
      verification: ["verification passed"],
      metadata: {
        auto_created: true,
        capture_action: "skipped",
        capture_reason: reason,
        reviewer_passed: false,
        promotion_eligible: false,
        promotion_review: { decision: "rejected", source: "task-experience-reviewer", reason },
      },
    });
  }
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-approved",
    task_class: "clawlore_quality_check",
    task_goal: "Approved ClawLore focused verification",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: ["focused test passed"],
    verification: ["verification passed"],
    metadata: {
      promotion_eligible: true,
      reviewer_passed: true,
      promotion_review: { decision: "approved", source: "task-experience-reviewer" },
    },
  });

  const preview = promoteExperiences(db, { scope_id: "agent:main", dry_run: true });
  assert.equal(preview.episodes_scanned, 5);
  assert.equal(preview.playbooks_created, 1);
  assert.equal(preview.playbooks_promoted, 1);
  assert.equal(preview.skipped, 4);
  assert.equal(
    preview.items.filter((item) => item.action === "skip" && item.reason === "promotion_not_eligible").length,
    4,
  );
});

test("automatic promotion reuses the canonical secret policy", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-secret-policy",
    task_class: "clawlore_quality_check",
    task_goal: "Review the authentication adapter without persisting credentials.",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: [
      JSON.stringify({ log: "Authorization: Digest username=\\\"demo\\\", response=\\\"SyntheticPromotionSecret123\\\"" }),
    ],
    verification: ["focused test passed"],
    metadata: {
      promotion_eligible: true,
      reviewer_passed: true,
      promotion_review: { decision: "approved", source: "roadmap-test-reviewer" },
    },
  });

  const preview = promoteExperiences(db, { scope_id: "agent:main", dry_run: true });
  assert.equal(preview.playbooks_created, 0);
  assert.equal(preview.items[0].reason, "secret-like-content");
});

test("legacy episodes are explicitly reported as frozen historical records", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "legacy-session",
    task_goal: "Historical task recorded before promotion review provenance existed",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: ["historical verification passed"],
    verification: ["passed"],
  });

  const preview = promoteExperiences(db, { scope_id: "agent:main", dry_run: true });
  assert.equal(preview.playbooks_created, 0);
  assert.equal(preview.historical_episodes_frozen, 1);
  assert.equal(preview.items[0].reason, "legacy_episode_historical");
});

test("scope policy labels global, same-scope, and cross-customer decisions", () => {
  const current = scopeIdForContext({ agent_id: "main" });
  assert.equal(current, "agent:main");

  const global = evaluateRecallScopePolicy({
    current_scope: current,
    candidate_scope: "global",
  });
  assert.equal(global.injectable, true);
  assert.equal(global.label, "global_shared");

  const cross = evaluateRecallScopePolicy({
    current_scope: current,
    candidate_scope: "custom:customer:work-pc",
  });
  assert.equal(cross.injectable, false);
  assert.equal(cross.crossed_scope, true);
  assert.equal(cross.label, "cross_scope_review");

  const allowed = evaluateRecallScopePolicy({
    current_scope: current,
    candidate_scope: "custom:customer:work-pc",
    allow_cross_scope: true,
  });
  assert.equal(allowed.injectable, true);
  assert.equal(allowed.label, "cross_scope_allowed");
});

test("knowledge/skill bridge generates drafts and dedupes existing truth without writing Markdown", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const covered = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Existing OpenClaw gateway recovery runbook",
      trigger: "gateway recovery",
      status: "promoted",
    }),
  });
  createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "High risk remote service restart workflow",
      trigger: "remote service restart",
      steps: [
        {
          number: 1,
          capability_class: "read_only",
          action: "Inspect service state.",
          evidence_required: "systemctl status",
        },
        {
          number: 2,
          capability_class: "service_control",
          action: "Restart only after authorization.",
          evidence_required: "explicit authorization and health check",
        },
      ],
      status: "promoted",
    }),
  });

  const preview = buildKnowledgeSkillDrafts(db, {
    scope_id: "agent:main",
    existing_docs: [
      {
        path: "knowledge/openclaw/gateway-recovery-playbook.md",
        title: "Existing OpenClaw gateway recovery runbook",
        text: "Existing OpenClaw gateway recovery runbook",
      },
    ],
  });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.recorded, false);
  assert.equal(tableExists(db, "knowledge_skill_promotion_drafts"), false);
  assert.ok(preview.drafts.some((draft) => draft.playbook_id === covered.id && draft.target_kind === "already_covered"));
  assert.ok(preview.drafts.some((draft) => draft.target_kind === "skill"));

  const recorded = buildKnowledgeSkillDrafts(db, {
    scope_id: "agent:main",
    record: true,
  });
  assert.equal(recorded.recorded, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_skill_promotion_drafts").get().count,
    recorded.count,
  );
});
