import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
  agentEndEventAllowsTaskExperience,
  buildTaskExperienceEpisodeDraft,
  captureTaskExperience,
  extractTaskExperienceTranscript,
  finalAssistantLooksUnsuccessful,
  formatTaskExperienceMemoryText,
  isReusableTaskExperience,
  normalizeTaskExperienceReview,
  shouldRecordTaskExperienceEpisode,
  shouldAttemptTaskExperienceCapture,
} = jiti("../src/task-experience.ts");

test("agent_end task-experience capture allows missing success but rejects explicit failure", () => {
  assert.equal(agentEndEventAllowsTaskExperience({ messages: [] }), true);
  assert.equal(agentEndEventAllowsTaskExperience({ success: true, messages: [] }), true);
  assert.equal(agentEndEventAllowsTaskExperience({ success: false, messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ status: "failed", messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ outcome: "error", messages: [] }), false);
});

test("successful tool-backed transcripts pass the task-experience gate", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Please fix the workspace audit flow and verify it end to end." },
    {
      role: "assistant",
      content:
        "I will inspect the audit scripts, identify which files are generated residue, create a reversible archive, avoid touching canonical workspace files, and verify with both audit commands.",
    },
    {
      role: "tool",
      content:
        "exit_code=0\nThe first audit identified generated session backup residue outside the workspace. The second audit returned WORKSPACE_LAYOUT_OK and STATE_HYGIENE_OK after cleanup.",
    },
    {
      role: "assistant",
      content:
        "Completed and verified. I updated the audit flow, reran both audit scripts, confirmed the pass outputs, and kept the rollback notes in the archive.",
    },
  ], 20_000);

  assert.equal(transcript.toolLikeCount, 1);
  const gate = shouldAttemptTaskExperienceCapture(transcript, {
    ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
    enabled: true,
  });
  assert.deepEqual(gate, { ok: true });
});

test("task-experience transcript extraction redacts obvious secrets before LLM review", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Update apiKey=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 and retry." },
    { role: "assistant", content: "I will replace the token with a vault reference and verify without echoing it." },
    { role: "tool", content: "exit_code=0\nconfig now uses env var AIzaSy012345678901234567890123456789" },
    { role: "assistant", content: "Completed and verified with the health probe." },
  ]);

  assert.doesNotMatch(transcript.text, /sk-proj-/);
  assert.doesNotMatch(transcript.text, /AIzaSy/);
  assert.match(transcript.text, /\[REDACTED_/);
});

test("unsuccessful or unverified final answers are not captured", () => {
  assert.equal(finalAssistantLooksUnsuccessful("我已经修改了，但还没有验证，不能确认成功。"), true);

  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Fix the service and verify it." },
    { role: "assistant", content: "I will inspect the unit, logs, config, and run a health probe after the smallest fix." },
    { role: "tool", content: "exit_code=0\nsystemctl status collected and config parsed" },
    { role: "tool", content: "exit_code=1\nhealth probe still failed after restart" },
    { role: "assistant", content: "我做了修改，但未验证通过，不能确认成功。" },
  ]);

  const gate = shouldAttemptTaskExperienceCapture(transcript, {
    ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
    enabled: true,
  });
  assert.deepEqual(gate, { ok: false, reason: "final_answer_not_successful" });
});

test("simple chat without tool evidence is not captured as task experience", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "What is a SQL index?" },
    { role: "assistant", content: "A SQL index speeds up lookups by maintaining an auxiliary data structure." },
  ]);
  const gate = shouldAttemptTaskExperienceCapture(transcript, {
    ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
    enabled: true,
  });
  assert.deepEqual(gate, { ok: false, reason: "too_few_messages" });
});

test("reviewer-skipped tool-backed tasks still produce an episode draft", async () => {
  const messages = [
    {
      role: "user",
      content:
        "Repair the OpenClaw digest recovery check and verify it with the narrow test command before reporting back.",
    },
    {
      role: "assistant",
      content:
        "I will inspect the digest recovery path, reproduce the failing check, patch only the recovery decision branch, and verify with the focused test plus a read-only status check.",
    },
    {
      role: "tool",
      name: "exec_command",
      content:
        "Command completed | status=completed\nThe focused digest recovery test reproduced the stale ledger handling issue and showed the recovery branch was skipped.",
    },
    {
      role: "tool",
      name: "exec_command",
      content:
        "Command completed | status=completed\nThe focused digest recovery test now passes, and the read-only status check reports the digest ledger is consistent.",
    },
    {
      role: "assistant",
      content:
        "Completed and verified. I patched only the digest recovery decision branch, reran the focused recovery test, confirmed the status check, and did not leave temporary files behind.",
    },
  ];
  const config = {
    ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
    enabled: true,
    minMessages: 3,
    minToolCalls: 1,
  };

  const result = await captureTaskExperience({
    messages,
    sessionKey: "agent:main:telegram:8176453077",
    agentId: "main",
    scope: "agent:main",
    config,
    llmClient: {
      async completeJson() {
        return {
          should_store: true,
          confidence: 0.2,
          task_type: "Digest recovery repair",
          steps: ["Inspect recovery status", "Patch the decision branch"],
          verification: ["Focused recovery test passes"],
        };
      },
      getLastError() {
        return null;
      },
    },
    embedder: {
      async embedPassage() {
        throw new Error("embedder should not run when reviewer confidence is too low");
      },
    },
    store: {
      async vectorSearch() {
        throw new Error("vector search should not run when reviewer confidence is too low");
      },
      async store() {
        throw new Error("store should not run when reviewer confidence is too low");
      },
    },
  });

  assert.deepEqual(result, { action: "skipped", reason: "review_invalid_or_low_confidence" });
  const transcript = extractTaskExperienceTranscript(messages, config.maxInputChars);
  assert.equal(shouldRecordTaskExperienceEpisode(transcript, result), true);
  const draft = buildTaskExperienceEpisodeDraft({ transcript, result, agentId: "main" });
  assert.ok(draft);
  assert.equal(draft.outcome, "success");
  assert.equal(draft.status, "completed");
  assert.equal(draft.metadata.capture_action, "skipped");
  assert.equal(draft.metadata.capture_reason, "review_invalid_or_low_confidence");
  assert.equal(draft.metadata.reviewer_passed, false);
  assert.equal(draft.tool_names.includes("exec_command"), true);
  assert.match(draft.task_goal, /OpenClaw digest recovery/);

  const chatTranscript = extractTaskExperienceTranscript([
    { role: "user", content: "What is a SQL index?" },
    { role: "assistant", content: "A SQL index speeds up lookups by maintaining an auxiliary structure." },
  ]);
  const chatResult = { action: "skipped", reason: "too_few_messages" };
  assert.equal(shouldRecordTaskExperienceEpisode(chatTranscript, chatResult), false);
  assert.equal(buildTaskExperienceEpisodeDraft({ transcript: chatTranscript, result: chatResult, agentId: "main" }), null);
});

test("review normalization requires replayable steps and verification", () => {
  assert.equal(
    normalizeTaskExperienceReview({
      should_store: true,
      confidence: 0.9,
      task_type: "Gateway health repair",
      steps: ["Read service status"],
      verification: [],
    }),
    null,
  );

  const review = normalizeTaskExperienceReview({
    should_store: true,
    confidence: 0.9,
    task_type: "Gateway health repair",
    trigger_phrases: ["gateway health", "service repair"],
    applicability: ["OpenClaw Gateway service health checks fail"],
    preconditions: ["Confirm the active unit name"],
    steps: ["Read systemd status", "Inspect recent logs", "Make the smallest config/code change"],
    verification: ["curl /healthz returns success", "recent logs have no new crash"],
    failure_signals: ["health endpoint times out"],
    safety_boundaries: ["Do not claim service normal until the probe passes"],
    cleanup: ["Remove temporary probes"],
    evidence_required: ["status output", "health probe output"],
  });

  assert.ok(review);
  const text = formatTaskExperienceMemoryText(review);
  assert.match(text, /Reusable Task Experience: Gateway health repair/);
  assert.match(text, /Verification Gate:/);
});

test("captureTaskExperience writes a durable reusable capsule through store.store", async () => {
  const messages = [
    { role: "user", content: "Fix the state hygiene residue and verify the audit is clean." },
    { role: "assistant", content: "I am checking the state hygiene audit, preserving backups, and applying a narrow cleanup." },
    { role: "tool", content: "Command completed | status=completed\nSTATE_HYGIENE_ISSUES session_backup_residue=2" },
    { role: "tool", content: "Command completed | status=completed\nSTATE_HYGIENE_OK\nWORKSPACE_LAYOUT_OK" },
    {
      role: "assistant",
      content:
        "Completed. The residue was reversibly archived, the daily note was updated, and both workspace-layout and state-hygiene audits now pass.",
    },
  ];
  let storedEntry;
  const result = await captureTaskExperience({
    messages,
    sessionKey: "agent:main:telegram:8176453077",
    sessionId: "session-1",
    agentId: "main",
    scope: "agent:main",
    config: {
      ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
      enabled: true,
      minMessages: 3,
      minToolCalls: 1,
    },
    llmClient: {
      async completeJson() {
        return {
          should_store: true,
          confidence: 0.91,
          task_type: "State hygiene residue cleanup",
          trigger_phrases: ["state-hygiene residue", "session backup residue"],
          applicability: ["state-hygiene-audit reports session backup residue"],
          preconditions: ["Confirm residues are outside workspace and not referenced by sessions.json"],
          steps: ["Run the state hygiene audit", "Create a reversible archive", "Move only confirmed residue files"],
          verification: ["Rerun state-hygiene-audit and workspace-layout-audit"],
          failure_signals: ["Audit still reports residue after cleanup"],
          safety_boundaries: ["Do not delete user session truth; archive reversibly"],
          cleanup: ["Remove only temporary probe output"],
          evidence_required: ["Final audit outputs"],
        };
      },
      getLastError() {
        return null;
      },
    },
    embedder: {
      async embedPassage() {
        return [1, 0, 0, 0];
      },
    },
    store: {
      async vectorSearch() {
        return [];
      },
      async store(entry) {
        storedEntry = { ...entry, id: "exp-1", timestamp: 123 };
        return storedEntry;
      },
    },
  });

  assert.deepEqual(result, {
    action: "created",
    id: "exp-1",
    taskType: "State hygiene residue cleanup",
  });
  assert.equal(storedEntry.category, "other");
  assert.equal(storedEntry.scope, "agent:main");
  const metadata = JSON.parse(storedEntry.metadata);
  assert.equal(metadata.type, "reusable-task-experience");
  assert.equal(metadata.reusable_task_experience, true);
  assert.equal(metadata.memory_layer, "durable");
  assert.equal(metadata.source, "task-experience");
  assert.ok(isReusableTaskExperience(storedEntry));
});

test("generic other memories do not suppress reusable task experience capture as duplicates", async () => {
  const messages = [
    { role: "user", content: "Repair the OpenClaw plugin config and verify the gateway." },
    { role: "assistant", content: "I will back up the config, make a minimal schema-safe edit, and verify health plus logs." },
    { role: "tool", content: "Command completed | status=completed\nbackup created and JSON validation passed" },
    { role: "tool", content: "Command completed | status=completed\nhealthz ok and recent logs clean" },
    { role: "assistant", content: "Completed and verified. The config was backed up, edited, validated, and the live health probe passed." },
  ];
  let storeCalled = false;
  const result = await captureTaskExperience({
    messages,
    sessionKey: "agent:main:telegram:8176453077",
    agentId: "main",
    scope: "agent:main",
    config: {
      ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
      enabled: true,
      minMessages: 3,
    },
    llmClient: {
      async completeJson() {
        return {
          should_store: true,
          confidence: 0.93,
          task_type: "Schema-safe plugin config repair",
          trigger_phrases: ["plugin config repair", "gateway config validation"],
          applicability: ["OpenClaw plugin config needs a narrow live edit"],
          preconditions: ["Confirm the live config path and plugin id"],
          steps: ["Back up the config", "Apply a minimal schema-safe edit", "Validate JSON before restart"],
          verification: ["Health probe passes", "Recent logs show no config errors"],
          failure_signals: ["JSON validation fails", "health probe times out"],
          safety_boundaries: ["Do not expose secret config values"],
          cleanup: ["Remove temporary probes"],
          evidence_required: ["backup path", "validation output", "health probe output"],
        };
      },
      getLastError() {
        return null;
      },
    },
    embedder: {
      async embedPassage() {
        return [1, 0, 0, 0];
      },
    },
    store: {
      async vectorSearch() {
        return [{
          score: 0.99,
          entry: {
            id: "generic-other",
            text: "A generic non-task memory about plugin configuration.",
            vector: [1, 0, 0, 0],
            category: "other",
            scope: "agent:main",
            importance: 0.6,
            timestamp: 123,
            metadata: JSON.stringify({ source: "manual", state: "confirmed" }),
          },
        }];
      },
      async store(entry) {
        storeCalled = true;
        return { ...entry, id: "exp-2", timestamp: 456 };
      },
    },
  });

  assert.equal(storeCalled, true);
  assert.deepEqual(result, {
    action: "created",
    id: "exp-2",
    taskType: "Schema-safe plugin config repair",
  });
});
