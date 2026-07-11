import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { registerExperienceTools, EXPERIENCE_TOOL_NAMES } = jiti("../src/experience-tools.ts");
const { buildForgettingReport, runForgetting, runForgettingWithVectorSync } = jiti("../src/forgetting.ts");
const {
  createPlaybook,
  createTaskEpisode,
  ensureExperienceSchema,
  recordTaskExperienceCaptureEvent,
  searchPlaybooks,
} = jiti("../src/experience-store.ts");
const { buildExperienceDebtReport } = jiti("../src/experience-governance.ts");
const { loadReplayCases, runReplaySuite } = jiti("../src/experience-replay.ts");

function createExperienceToolMap(toolCtx = { agentId: "main", sessionId: "session-1" }) {
  const tools = new Map();
  const api = {
    registerTool(factory, meta) {
      assert.ok(meta?.name, "Experience tool registration must include metadata.name");
      tools.set(meta.name, factory(toolCtx));
    },
  };
  const context = {
    retriever: {},
    store: {},
    scopeManager: {
      getDefaultScope: (agentId) => `agent:${agentId}`,
      getScopeFilter: (agentId) => [`agent:${agentId}`, "global"],
      isAccessible: (scope, agentId) => scope === `agent:${agentId}` || scope === "global",
    },
    embedder: {},
    db: async () => null,
  };
  registerExperienceTools(api, context, { enableManagementTools: true });
  return tools;
}

function createExperienceToolMapWithDb(db, toolCtx = { agentId: "main", sessionId: "session-1" }) {
  const tools = new Map();
  const api = {
    registerTool(factory, meta) {
      assert.ok(meta?.name, "Experience tool registration must include metadata.name");
      tools.set(meta.name, factory(toolCtx));
    },
  };
  const context = {
    retriever: {},
    store: {},
    scopeManager: {
      getDefaultScope: (agentId) => `agent:${agentId}`,
      getScopeFilter: (agentId) => [`agent:${agentId}`, "global"],
      isAccessible: (scope, agentId) => scope === `agent:${agentId}` || scope === "global",
    },
    embedder: {},
    db: async () => db,
  };
  registerExperienceTools(api, context, { enableManagementTools: true });
  return tools;
}

test("Experience Kernel registers discoverable scope_recall tools", async () => {
  const tools = createExperienceToolMap();
  for (const name of EXPERIENCE_TOOL_NAMES) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }
  assert.equal(tools.get("scope_recall_playbook_search").name, "scope_recall_playbook_search");
  assert.equal(tools.get("scope_recall_forgetting_run").name, "scope_recall_forgetting_run");
});

test("Experience Kernel default Agent surface contains only read-only guidance tools", async () => {
  const tools = new Map();
  const api = {
    registerTool(factory, metadata) {
      const tool = factory({ agentId: "audit-agent" });
      tools.set(metadata?.name ?? tool.name, tool);
    },
  };
  registerExperienceTools(api, {
    retriever: {},
    store: {},
    scopeManager: {
      getDefaultScope: (agentId) => `agent:${agentId}`,
      getScopeFilter: (agentId) => [`agent:${agentId}`, "global"],
      isAccessible: (scope, agentId) => scope === `agent:${agentId}` || scope === "global",
    },
    embedder: {},
    db: async () => null,
  });
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "scope_recall_experience_preflight",
      "scope_recall_playbook_inspect",
      "scope_recall_playbook_search",
    ],
  );
});

test("Experience Kernel tools fail closed without runtime agent context", async () => {
  const tools = createExperienceToolMap({});
  const result = await tools.get("scope_recall_playbook_search").execute("call-1", { query: "deploy" });
  assert.equal(result.details.error, "missing_agent_context");
});

test("Experience governance debt reports missing schema without mutation", () => {
  const db = new DatabaseSync(":memory:");
  const report = buildExperienceDebtReport(db, { now_ms: Date.UTC(2026, 6, 1) });
  assert.equal(report.status, "schema_missing");
  assert.ok(report.missing_tables.includes("task_episodes"));
  assert.equal(report.debt.ready_to_promote_episodes.count, 0);
});

function createMemoryTruthDb() {
  const db = new DatabaseSync(":memory:");
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
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(
      memory_id UNINDEXED,
      text,
      metadata_text
    );
  `);
  const insert = db.prepare(
    "INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("dup-old", "Use release gate before publishing scope recall.", "fact", "agent:main", 0.7, 1, '{"state":"confirmed"}', "", 1);
  insert.run("dup-new", "Use release gate before publishing scope recall.", "fact", "agent:main", 0.7, 2, '{"state":"confirmed"}', "", 2);
  insert.run("short", "ok", "other", "agent:main", 0.1, 3, '{"state":"confirmed"}', "", 3);
  insert.run("secret-row", "password = \"not-a-real-secret-value-123\"", "fact", "agent:main", 0.9, 4, '{"state":"confirmed"}', "", 4);
  return db;
}

test("forgetting report is scoped, redacts sensitive previews, and run soft-archives only by default", () => {
  const db = createMemoryTruthDb();
  const report = buildForgettingReport(db, { scopeFilter: ["agent:main"] });
  assert.equal(report.duplicate_groups.count, 1);
  assert.ok(report.soft_archive_candidates.items.some((item) => item.id === "dup-new"));
  assert.ok(report.soft_archive_candidates.items.some((item) => item.id === "short"));
  const secret = report.hard_delete_candidates.items.find((item) => item.id === "secret-row");
  assert.equal(secret?.preview, "[redacted: secret-like content]");

  const dry = runForgetting(db, { scopeFilter: ["agent:main"] });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.archive_ids.includes("dup-new"));
  assert.ok(dry.delete_ids.length === 0);

  const applied = runForgetting(db, { scopeFilter: ["agent:main"], dryRun: false });
  assert.equal(applied.deleted, 0);
  const archived = db.prepare("SELECT metadata FROM memory_truth WHERE id = ?").get("dup-new");
  assert.match(String(archived.metadata), /"state":"archived"/);
  const stillPresent = db.prepare("SELECT id FROM memory_truth WHERE id = ?").get("secret-row");
  assert.equal(stillPresent.id, "secret-row");
});

test("hard forgetting syncs vector companion deletes", async () => {
  const db = createMemoryTruthDb();
  const vectorIds = [];
  const applied = await runForgettingWithVectorSync(db, {
    scopeFilter: ["agent:main"],
    dryRun: false,
    hardDeleteSensitive: true,
    deleteVectorById: async (id) => {
      vectorIds.push(id);
      return true;
    },
  });

  assert.equal(applied.deleted, 1);
  assert.deepEqual(vectorIds, ["secret-row"]);
  assert.equal(applied.vector_deleted, 1);
  assert.equal(applied.needs_repair, false);
  const gone = db.prepare("SELECT id FROM memory_truth WHERE id = ?").get("secret-row");
  assert.equal(gone, undefined);
});

test("hard forgetting blocks SQL deletion when vector companion delete fails", async () => {
  const db = createMemoryTruthDb();
  const applied = await runForgettingWithVectorSync(db, {
    scopeFilter: ["agent:main"],
    dryRun: false,
    hardDeleteSensitive: true,
    deleteVectorById: async () => false,
  });

  assert.equal(applied.deleted, 0);
  assert.equal(applied.vector_deleted, 0);
  assert.equal(applied.needs_repair, true);
  assert.equal(applied.hard_delete_blocked, true);
  assert.deepEqual(applied.vector_delete_errors, ["secret-row"]);
  const stillPresent = db.prepare("SELECT id FROM memory_truth WHERE id = ?").get("secret-row");
  assert.equal(stillPresent.id, "secret-row");
});

function createPlaybookPayload(overrides = {}) {
  return {
    task_class: "release-hardening",
    title: "Release gate FTS safety",
    trigger: "scope recall release gate with 中文 rollback checks",
    goal: "Find playbooks even when user queries contain punctuation and FTS operators",
    preconditions: [{ check: "workspace and extension are known" }],
    steps: [
      {
        number: 1,
        capability_class: "read_only",
        action: "Inspect workspace and extension drift",
        evidence_required: "file hash comparison",
      },
      {
        number: 2,
        capability_class: "local_write",
        action: "Patch the release gate and rerun tests",
        evidence_required: "release gate output",
      },
    ],
    pitfalls: [{ note: "raw FTS MATCH queries can throw on quotes, colons, or minus signs" }],
    verification: ["Search accepts special-character queries without throwing"],
    cleanup: ["Remove temporary release artifacts"],
    reuse_policy: { scope: "same plugin release workflow" },
    status: "candidate",
    confidence: 0.8,
    ...overrides,
  };
}

test("playbook FTS search sanitizes special-character queries", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const playbook = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload(),
  });

  const results = searchPlaybooks(db, {
    query: 'FTS: deploy("rollback") -中文 path/to:file',
    scope_ids: ["agent:main"],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, playbook.id);
  assert.doesNotThrow(() => searchPlaybooks(db, { query: ':"()-', scope_ids: ["agent:main"] }));
  assert.deepEqual(searchPlaybooks(db, { query: ':"()-', scope_ids: ["agent:main"] }), []);
});

test("preflight isolates playbooks by runtime scope and feedback records a run", async () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const mine = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Scope isolation release checklist",
      trigger: "scope isolation release validation",
      status: "promoted",
    }),
  });
  createPlaybook(db, {
    scope_id: "agent:other",
    payload: createPlaybookPayload({
      title: "Other agent private checklist",
      trigger: "scope isolation release validation",
      status: "promoted",
    }),
  });

  const tools = createExperienceToolMapWithDb(db);
  const preflight = await tools.get("scope_recall_experience_preflight").execute("call-1", {
    task_description: "scope isolation release validation",
  });
  assert.equal(preflight.details.found, true);
  assert.equal(preflight.details.count, 1);
  assert.equal(preflight.details.playbooks[0].id, mine.id);

  const feedback = await tools.get("scope_recall_playbook_feedback").execute("call-2", {
    playbook_id: mine.id,
    outcome: "success",
    steps_completed: [1, 2],
    evidence: ["preflight returned only the caller scope playbook"],
    outcome_reason: "scope-filtered preflight and verification succeeded",
  });
  assert.equal(feedback.details.outcome, "success");
  const run = db.prepare("SELECT * FROM experience_runs WHERE id = ?").get(feedback.details.run_id);
  assert.equal(run.playbook_id, mine.id);
  assert.equal(run.scope_id, "agent:main");
  assert.equal(run.outcome, "success");
  assert.ok(run.finished_at);
});

test("Experience governance debt classifies promotion and review backlog", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const nowMs = Date.UTC(2026, 6, 1);
  const oldIso = new Date(Date.UTC(2026, 5, 1)).toISOString();

  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-ready",
    task_class: "scope_recall_quality_check",
    task_goal: "Add an operator debt report and verify it with focused tests.",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test", "tsc"],
    evidence: ["node --test tests/experience-kernel.test.mjs passed"],
    verification: ["typecheck passed"],
  });

  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-blocked",
    task_class: "scope_recall_quality_check",
    task_goal: "A successful task without verification should stay blocked.",
    status: "completed",
    outcome: "success",
    tool_names: ["node:test"],
    evidence: ["manual observation only"],
    verification: [],
  });

  const linkedEpisode = createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-linked",
    task_class: "release-hardening",
    task_goal: "Already converted to a playbook.",
    status: "completed",
    outcome: "success",
    tool_names: ["release:gate"],
    evidence: ["release gate passed"],
    verification: ["pack scan passed"],
  });

  createPlaybook(db, {
    scope_id: "agent:main",
    created_from_episode_id: linkedEpisode.id,
    payload: createPlaybookPayload({
      title: "Linked release hardening playbook",
      status: "promoted",
    }),
  });

  const staleCandidate = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Stale candidate playbook",
      status: "candidate",
    }),
  });
  db.prepare("UPDATE procedural_playbooks SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(oldIso, oldIso, staleCandidate.id);

  createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Needs review playbook",
      status: "needs_review",
    }),
  });

  const failing = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Failing promoted playbook",
      status: "promoted",
    }),
  });
  db.prepare("UPDATE procedural_playbooks SET success_count = 0, failure_count = 3 WHERE id = ?")
    .run(failing.id);

  const report = buildExperienceDebtReport(db, {
    scope_id: "agent:main",
    stale_candidate_days: 14,
    now_ms: nowMs,
  });

  assert.equal(report.status, "attention_needed");
  assert.equal(report.totals.episodes.completed_success, 3);
  assert.equal(report.totals.episodes.completed_success_linked, 1);
  assert.equal(report.totals.capture_events.total, 0);
  assert.equal(report.debt.ready_to_promote_episodes.count, 1);
  assert.equal(report.debt.blocked_success_episodes.count, 1);
  assert.equal(report.debt.review_backlog_playbooks.count, 2);
  assert.equal(report.debt.stale_candidate_playbooks.count, 1);
  assert.equal(report.debt.failing_playbooks.count, 1);
  assert.ok(report.recommendations.some((item) => item.kind === "ready_to_promote_episodes"));
  assert.ok(report.recommendations.some((item) => item.kind === "failing_playbooks"));
});

test("Experience governance debt surfaces skipped task-experience captures", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  recordTaskExperienceCaptureEvent(db, {
    scope_id: "agent:main",
    session_id: "session-low-confidence",
    agent_id: "main",
    action: "skipped",
    reason: "review_invalid_or_low_confidence",
  });
  recordTaskExperienceCaptureEvent(db, {
    scope_id: "agent:main",
    session_id: "session-created",
    agent_id: "main",
    action: "created",
    task_class: "Release gate repair",
    memory_id: "mem-1",
  });

  const report = buildExperienceDebtReport(db, { scope_id: "agent:main" });
  assert.equal(report.status, "attention_needed");
  assert.equal(report.totals.capture_events.total, 2);
  assert.equal(report.totals.capture_events.skipped, 1);
  assert.equal(report.totals.capture_skip_reasons.review_invalid_or_low_confidence, 1);
  assert.equal(report.debt.skipped_capture_events.count, 1);
  assert.equal(report.debt.skipped_capture_events.items[0].reason, "review_invalid_or_low_confidence");
  assert.ok(report.recommendations.some((item) => item.kind === "skipped_capture_events"));
});

test("Experience governance debt redacts secret-like task previews", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  createTaskEpisode(db, {
    scope_id: "agent:main",
    session_id: "session-secret",
    task_class: "credential_adjacent",
    task_goal: "Investigate api_key = sk-test-not-real-but-secret-shaped-1234567890 in pasted logs.",
    status: "completed",
    outcome: "success",
    tool_names: ["rg"],
    evidence: ["redacted log scan completed"],
    verification: ["confirmed no credential was stored"],
  });

  const report = buildExperienceDebtReport(db, { scope_id: "agent:main" });
  assert.equal(report.debt.blocked_success_episodes.count, 1);
  assert.match(report.debt.blocked_success_episodes.items[0].reasons.join(","), /secret_like_content/);
  assert.doesNotMatch(JSON.stringify(report), /sk-test-not-real/);
});

test("Experience replay benchmark covers common OpenClaw workflows", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const cases = loadReplayCases(JSON.parse(readFileSync(new URL("../benchmarks/experience-replay-cases.json", import.meta.url), "utf8")));
  assert.equal(cases.length, 6);

  const playbook = createPlaybook(db, {
    scope_id: "agent:main",
    payload: createPlaybookPayload({
      title: "Commercial OpenClaw release and recovery runbook",
      trigger: "config change gateway recovery vector repair release gate plugin rollout telegram delivery",
      goal: [
        "backup validate health rollback",
        "systemctl journalctl port healthz",
        "doctor repair-vectors dry-run apply",
        "npm test typecheck build release gate",
        "backup live extension sync inspect smoke",
        "telegram visible replies route smoke message",
      ].join("; "),
      steps: [
        {
          number: 1,
          capability_class: "read_only",
          action: "Inspect current state before touching config, Gateway service, vectors, release files, or Telegram delivery.",
          evidence_required: "status, logs, and route evidence",
        },
        {
          number: 2,
          capability_class: "local_write",
          action: "Back up files first, then validate, run health probes, and keep rollback evidence.",
          evidence_required: "backup path, validate output, healthz output, rollback command",
        },
        {
          number: 3,
          capability_class: "service_control",
          action: "Run doctor, repair-vectors dry-run, explicit apply only when authorized, npm test, typecheck, build, and release gate.",
          evidence_required: "doctor output, dry-run output, apply output, release gate output",
        },
        {
          number: 4,
          capability_class: "local_write",
          action: "For live plugin rollout, backup live extension, sync package files, inspect plugin, run doctor, and smoke live CLI.",
          evidence_required: "inspect output, doctor output, smoke output",
        },
        {
          number: 5,
          capability_class: "network_or_remote",
          action: "For Telegram delivery, verify visible replies, channel route, send a smoke message, and confirm final delivery.",
          evidence_required: "route output and smoke message id",
        },
      ],
      pitfalls: [
        { note: "Evidence is required before release statements." },
        { note: "Validation is mandatory before live rollout." },
      ],
      verification: ["Replay cases pass without forbidden negative terms"],
      status: "promoted",
    }),
  });

  const suite = runReplaySuite(db, playbook.id, cases);
  assert.equal(suite.total, 6);
  assert.equal(suite.failed, 0);
  assert.equal(suite.passed, 6);
});
