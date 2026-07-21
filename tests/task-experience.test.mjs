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
const { structuredToolOutcome } = jiti("../src/task-outcome-evidence.ts");

test("agent_end task-experience capture requires explicit structured success", () => {
  assert.equal(agentEndEventAllowsTaskExperience({ messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ success: true, messages: [] }), true);
  assert.equal(agentEndEventAllowsTaskExperience({ success: false, messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ status: "failed", messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ outcome: "error", messages: [] }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ success: true, error: { message: "failed" } }), false);
  assert.equal(agentEndEventAllowsTaskExperience({ success: true, errors: ["failed"] }), false);
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
      isError: false,
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
    { role: "tool", isError: false, content: "exit_code=0\nconfig now uses env var AIzaSy012345678901234567890123456789" },
    { role: "assistant", content: "Completed and verified with the health probe." },
  ]);

  assert.doesNotMatch(transcript.text, /sk-proj-/);
  assert.doesNotMatch(transcript.text, /AIzaSy/);
  assert.match(transcript.text, /\[REDACTED_/);
});

test("task-experience transcript extraction uses the unified env and HTTP-header secret policy", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Retry with DB_PASSWORD=CorrectHorse77!" },
    { role: "assistant", content: "I will use the configured vault reference." },
    { role: "tool", isError: false, content: "Authorization: Basic dXNlcjpwYXNzd29yZA==\nCookie: session_id=session-value-123" },
    { role: "assistant", content: "Completed and verified without echoing credentials." },
  ]);

  assert.doesNotMatch(transcript.text, /CorrectHorse77/);
  assert.doesNotMatch(transcript.text, /dXNlcjpwYXNzd29yZA/);
  assert.doesNotMatch(transcript.text, /session-value-123/);
  assert.match(transcript.text, /\[REDACTED_/);
});

test("task-experience transcript extraction redacts camelCase and YAML block secrets", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: '{"databasePassword":"Synthetic Value With Spaces 123"}' },
    { role: "assistant", content: "I will replace the inline credential with a SecretRef before running any command." },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: "DB_PASSWORD: >-\n  synthetic block value line one\n  line two" },
    { role: "assistant", content: "Completed and verified. The sanitized configuration test passed." },
  ]);

  assert.doesNotMatch(transcript.text, /Synthetic Value With Spaces 123/);
  assert.doesNotMatch(transcript.text, /synthetic block value line one/);
  assert.doesNotMatch(transcript.text, /line two/);
  assert.match(transcript.text, /\[REDACTED_STRUCTURED_SECRET_ASSIGNMENT\]/);
});

test("task-experience transcript extraction removes attachment cache paths before LLM review", () => {
  const transcript = extractTaskExperienceTranscript([
    {
      role: "user",
      content: "Audit the plugin thoroughly. [Image attached at: /tmp/clawlore-task-input-private.png]",
    },
    { role: "assistant", content: "I will inspect, patch, and verify the release gates." },
    { role: "tool", isError: false, content: "exit_code=0\nAll targeted tests passed." },
    { role: "assistant", content: "Completed and verified with the targeted tests." },
  ]);

  assert.doesNotMatch(transcript.text, /clawlore-task-input-private\.png/u);
  assert.doesNotMatch(transcript.userGoal, /\/tmp\//u);
});

test("unsuccessful or unverified final answers are not captured", () => {
  assert.equal(finalAssistantLooksUnsuccessful("我已经修改了，但还没有验证，不能确认成功。"), true);

  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Fix the service and verify it." },
    { role: "assistant", content: "I will inspect the unit, logs, config, and run a health probe after the smallest fix." },
    { role: "tool", isError: false, content: "exit_code=0\nsystemctl status collected and config parsed" },
    { role: "tool", isError: true, content: "exit_code=1\nhealth probe still failed after restart" },
    { role: "assistant", content: "我做了修改，但未验证通过，不能确认成功。" },
  ]);

  const gate = shouldAttemptTaskExperienceCapture(transcript, {
    ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
    enabled: true,
  });
  assert.deepEqual(gate, { ok: false, reason: "final_answer_not_successful" });
});

test("protective negatives do not turn verified completion into failure", () => {
  const matrix = [
    ["Deployment completed and all tests passed; it cannot overwrite the backup.", false],
    ["修复完成，验证通过；现在不能越权写入。", false],
    ["Deployment completed and all tests passed; unauthorized users cannot access the admin API.", false],
    ["部署完成并验证通过；未授权账户不能访问管理端。", false],
    ["Deployment completed; unauthorized users cannot access and cannot write.", false],
    ["Deployment completed; unauthorized users cannot access and still cannot write.", false],
    ["部署完成；未授权用户不能访问并且也不能写入。", false],
    ["Deployment completed; unauthorized users cannot access, but authorized users cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access and authorized users cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access while administrators cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access and employees cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access while paying customers cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access and ordinary staff cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access plus employees cannot access either.", true],
    ["Deployment completed; unauthorized users cannot access as well as paying customers cannot access either.", true],
    ["部署完成；未授权用户不能访问，但管理员也无法访问。", true],
    ["部署完成；未授权用户不能访问而管理员也无法访问。", true],
    ["部署完成；未授权用户不能访问并且已授权用户也无法访问。", true],
    ["部署完成；未授权用户不能访问，而且普通员工也无法访问。", true],
    ["部署完成；未授权用户不能访问以及普通员工也不能访问。", true],
    ["部署完成；未授权用户不能访问加上普通客户也无法访问。", true],
    ["Deployment completed and verified; employees still have no access.", true],
    ["Deployment completed and verified; neither can paying customers.", true],
    ["部署完成并验证通过；普通员工仍没有管理端访问权限。", true],
    ["The first probe failed, then the repair completed and the final health check passed.", false],
    ["The deployment remains blocked and is not verified.", true],
    ["配置已更新，但未验证通过，不能确认成功。", true],
    ["I cannot complete the repair because the service is unreachable.", true],
    ["I cannot access the target service, so deployment remains unverified.", true],
  ];
  for (const [text, unsuccessful] of matrix) {
    assert.equal(finalAssistantLooksUnsuccessful(text), unsuccessful, text);
  }
});

test("complete capture gate rejects authorized-user failures with structured tool success", () => {
  const failedFinals = [
    "Deployment completed and verified; employees still have no access.",
    "Deployment completed and verified; neither can paying customers.",
    "部署完成并验证通过；普通员工仍没有管理端访问权限。",
  ];
  for (const finalAssistant of failedFinals) {
    const transcript = extractTaskExperienceTranscript([
      { role: "user", content: "Repair the authorization policy and verify both denied and allowed principals with independent probes." },
      { role: "assistant", content: "I will inspect the policy, run an unauthorized-user probe, run an authorized-user probe, and report only after both outcomes are verified." },
      { role: "toolResult", toolCallId: "call-1", toolName: "exec", isError: false, content: "The policy probe command completed and returned its structured result envelope." },
      { role: "assistant", content: finalAssistant },
    ]);
    assert.deepEqual(
      shouldAttemptTaskExperienceCapture(transcript, {
        ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
        enabled: true,
      }, { success: true, messages: [] }),
      { ok: false, reason: "final_answer_not_successful" },
      finalAssistant,
    );
  }
});

test("capture gate requires structured tool success and a verified final outcome", () => {
  const base = [
    { role: "user", content: "Repair the service configuration and verify it with a focused test and a health probe." },
    { role: "assistant", content: "I will inspect the configuration, make the narrow repair, run the focused test, then run the health probe before reporting completion." },
    { role: "tool", content: "exit_code=0\nfocused test and health probe output were collected" },
    { role: "assistant", content: "Completed and verified. The focused test and final health probe passed after the repair." },
  ];
  const missingOutcome = extractTaskExperienceTranscript(base);
  assert.deepEqual(
    shouldAttemptTaskExperienceCapture(missingOutcome, { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, enabled: true }),
    { ok: false, reason: "structured_tool_outcome_missing" },
  );

  const terminalFailure = extractTaskExperienceTranscript([
    ...base.slice(0, 2),
    { ...base[2], isError: true },
    base[3],
  ]);
  assert.deepEqual(
    shouldAttemptTaskExperienceCapture(terminalFailure, { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, enabled: true }),
    { ok: false, reason: "tool_outcome_not_successful" },
  );

  const unverified = extractTaskExperienceTranscript([
    ...base.slice(0, 2),
    { ...base[2], isError: false },
    { role: "assistant", content: "The configuration was changed." },
  ]);
  assert.deepEqual(
    shouldAttemptTaskExperienceCapture(unverified, { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, enabled: true }),
    { ok: false, reason: "verified_success_not_established" },
  );
});

test("conflicting tool envelopes and unrelated later successes fail closed", () => {
  const conflicting = [
    { role: "tool", success: true, status: "failed" },
    { role: "tool", ok: true, result: { status: "failed" } },
    { role: "tool", isError: false, details: { error: "operation failed" } },
    { role: "tool", success: true, error: { message: "operation failed" } },
    { role: "tool", success: true, errors: ["operation failed"] },
  ];
  for (const envelope of conflicting) {
    assert.equal(structuredToolOutcome(envelope), "failure", JSON.stringify(envelope));
  }

  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Deploy the service and verify the deployment itself with focused tests and health checks before reporting completion." },
    { role: "assistant", content: "I will run the deployment, inspect every structured result, and only report success after the deployment and all verification probes succeed." },
    { role: "tool", name: "deploy", success: false, status: "failed", content: "The deployment operation returned a structured failure." },
    { role: "tool", name: "pwd", success: true, status: "completed", content: "The unrelated working-directory check completed successfully." },
    { role: "assistant", content: "Completed and verified. The working-directory check passed and the environment is healthy." },
  ]);
  assert.deepEqual(
    shouldAttemptTaskExperienceCapture(
      transcript,
      { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, enabled: true },
      { success: true },
    ),
    { ok: false, reason: "structured_tool_failure_present" },
  );
});

test("structured tool outcomes inspect nested arrays and distinguish HTTP from exit codes", () => {
  assert.equal(structuredToolOutcome({
    role: "tool",
    success: true,
    results: [{ status: "passed" }, { details: { success: false, error: { code: "denied" } } }],
  }), "failure");
  assert.equal(structuredToolOutcome({ role: "tool", code: 200 }), "success");
  assert.equal(structuredToolOutcome({ role: "tool", statusCode: 503 }), "failure");
  assert.equal(structuredToolOutcome({ role: "tool", exitCode: 200 }), "failure");
  assert.equal(structuredToolOutcome({ role: "assistant", toolCallId: "call-not-result", success: true }), null);
});

test("current task failure is not erased by trailing positive verification words", () => {
  assert.equal(
    finalAssistantLooksUnsuccessful("The deployment was not completed, but the checks passed and were verified."),
    true,
  );
  assert.equal(
    finalAssistantLooksUnsuccessful("The first probe failed, then the repair completed and the final health check passed."),
    false,
  );
  for (const text of [
    "The deployment did not succeed, although the checks were verified.",
    "The service remains unhealthy, but the test command passed.",
    "The final probe reported errors, although validation completed.",
    "部署检查完成，但服务仍不可用。",
    "Deployment completed and verified; administrators are still locked out.",
    "部署完成并验证通过；普通员工被拒绝访问。",
  ]) {
    assert.equal(finalAssistantLooksUnsuccessful(text), true, text);
  }
  assert.equal(
    finalAssistantLooksUnsuccessful("Deployment completed; unauthorized users receive 403 and the administrator probe passed."),
    false,
  );
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
      isError: false,
      name: "exec_command",
      content:
        "Command completed | status=completed\nThe focused digest recovery test reproduced the stale ledger handling issue and showed the recovery branch was skipped.",
    },
    {
      role: "tool",
      isError: false,
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
  assert.equal(draft.metadata.promotion_eligible, false);
  assert.deepEqual(draft.metadata.promotion_review, {
    source: "task-experience-reviewer",
    decision: "rejected",
    reason: "review_invalid_or_low_confidence",
  });
  assert.equal(draft.tool_names.includes("exec_command"), true);
  assert.match(draft.task_goal, /OpenClaw digest recovery/);

  const clawLoreDraft = buildTaskExperienceEpisodeDraft({
    transcript: {
      ...transcript,
      userGoal: "Refactor the ClawLore runtime configuration and verify the compatibility gate.",
    },
    result,
    agentId: "main",
  });
  assert.equal(clawLoreDraft.task_class, "clawlore_task");

  const chatTranscript = extractTaskExperienceTranscript([
    { role: "user", content: "What is a SQL index?" },
    { role: "assistant", content: "A SQL index speeds up lookups by maintaining an auxiliary structure." },
  ]);
  const chatResult = { action: "skipped", reason: "too_few_messages" };
  assert.equal(shouldRecordTaskExperienceEpisode(chatTranscript, chatResult), false);
  assert.equal(buildTaskExperienceEpisodeDraft({ transcript: chatTranscript, result: chatResult, agentId: "main" }), null);
});

test("outcome-gate failures never become successful experience episodes", () => {
  const transcript = extractTaskExperienceTranscript([
    { role: "user", content: "Repair the service and independently verify the focused test and final health probe." },
    { role: "assistant", content: "I will inspect the failure, make the narrow repair, and verify both the focused test and health probe before reporting success." },
    { role: "tool", isError: false, name: "exec", content: "exit_code=0\nThe focused test command returned a structured success envelope." },
    { role: "assistant", content: "The change was applied, but final verification is not established." },
  ]);

  for (const reason of [
    "agent_end_not_successful",
    "final_answer_not_successful",
    "structured_tool_outcome_missing",
    "tool_outcome_not_successful",
    "structured_tool_failure_present",
    "verified_success_not_established",
  ]) {
    const draft = buildTaskExperienceEpisodeDraft({
      transcript,
      result: { action: "skipped", reason },
      agentId: "main",
    });
    assert.ok(draft, reason);
    assert.equal(draft.outcome, "partial", reason);
    assert.equal(draft.metadata.promotion_eligible, false, reason);
  }
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

test("long task-experience capsules retain every safety-critical section inside recall budget", () => {
  const long = (label, index) => `${label} ${index}: ${"bounded operational detail ".repeat(9)}`;
  const review = {
    should_store: true,
    confidence: 0.95,
    task_type: "Production gateway recovery",
    trigger_phrases: Array.from({ length: 8 }, (_, index) => long("trigger", index)),
    applicability: Array.from({ length: 4 }, (_, index) => long("applicability", index)),
    preconditions: Array.from({ length: 4 }, (_, index) => long("precondition", index)),
    steps: Array.from({ length: 4 }, (_, index) => long("step", index)),
    verification: ["VERIFY_SENTINEL health probe and durable state both pass"],
    failure_signals: ["FAILURE_SENTINEL stop when the service remains unhealthy"],
    safety_boundaries: ["SAFETY_SENTINEL never claim success without evidence"],
    cleanup: ["CLEANUP_SENTINEL remove only owned temporary files"],
    evidence_required: ["EVIDENCE_SENTINEL retain the final health receipt"],
  };
  const persisted = formatTaskExperienceMemoryText(review, { maxChars: 2_400 });
  assert.ok(persisted.length <= 2_400);
  const recalled = persisted.slice(0, 1_600);
  for (const marker of [
    "VERIFY_SENTINEL",
    "FAILURE_SENTINEL",
    "SAFETY_SENTINEL",
    "CLEANUP_SENTINEL",
    "EVIDENCE_SENTINEL",
  ]) assert.match(recalled, new RegExp(marker), marker);
});

test("captureTaskExperience writes a durable reusable capsule through store.store", async () => {
  const messages = [
    { role: "user", content: "Fix the state hygiene residue and verify the audit is clean." },
    { role: "assistant", content: "I am checking the state hygiene audit, preserving backups, and applying a narrow cleanup." },
    { role: "tool", isError: false, content: "Command completed | status=completed\nSTATE_HYGIENE_ISSUES session_backup_residue=2" },
    { role: "tool", isError: false, content: "Command completed | status=completed\nSTATE_HYGIENE_OK\nWORKSPACE_LAYOUT_OK" },
    {
      role: "assistant",
      content:
        "Completed. The residue was reversibly archived, the daily note was updated, and both workspace-layout and state-hygiene audits now pass.",
    },
  ];
  let storedEntry;
  let embeddedText = "";
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
          cleanup: ["Remove only temporary probe output [Image attached at: /tmp/clawlore-task-private.png]"],
          evidence_required: ["Final audit outputs"],
        };
      },
      getLastError() {
        return null;
      },
    },
    embedder: {
      async embedPassage(text) {
        embeddedText = text;
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
    mirrorStatus: "not_configured",
  });
  assert.equal(storedEntry.category, "other");
  assert.equal(storedEntry.scope, "agent:main");
  const metadata = JSON.parse(storedEntry.metadata);
  assert.equal(metadata.type, "reusable-task-experience");
  assert.equal(metadata.reusable_task_experience, true);
  assert.equal(metadata.memory_layer, "durable");
  assert.equal(metadata.source, "task-experience");
  assert.ok(isReusableTaskExperience(storedEntry));
  assert.equal(embeddedText.includes("clawlore-task-private.png"), false);
  assert.equal(storedEntry.text.includes("clawlore-task-private.png"), false);
});

test("generic other memories do not suppress reusable task experience capture as duplicates", async () => {
  const messages = [
    { role: "user", content: "Repair the OpenClaw plugin config and verify the gateway." },
    { role: "assistant", content: "I will back up the config, make a minimal schema-safe edit, and verify health plus logs." },
    { role: "tool", isError: false, content: "Command completed | status=completed\nbackup created and JSON validation passed" },
    { role: "tool", isError: false, content: "Command completed | status=completed\nhealthz ok and recent logs clean" },
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
    mirrorStatus: "not_configured",
  });
});

test("markdown mirror failure returns a committed capture receipt with repair debt", async () => {
  const messages = [
    { role: "user", content: "Repair the gateway and verify it end to end." },
    { role: "assistant", content: "I will inspect, repair, verify, and retain rollback evidence." },
    {
      role: "tool",
      isError: false,
      content: `Command completed | status=completed\nhealth and durable state checks passed. ${"The bounded verification receipt confirms service state, durable state, and rollback readiness. ".repeat(6)}`,
    },
    { role: "assistant", content: "Completed and verified. Health and durable state checks passed." },
  ];
  let stored = false;
  const warnings = [];
  const result = await captureTaskExperience({
    messages,
    sessionKey: "agent:main:test",
    agentId: "main",
    scope: "agent:main",
    config: { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, enabled: true, minMessages: 3 },
    llmClient: {
      async completeJson() {
        return {
          should_store: true,
          confidence: 0.95,
          task_type: "Gateway recovery",
          trigger_phrases: ["gateway failure"],
          applicability: ["gateway health is degraded"],
          preconditions: ["confirm the active unit"],
          steps: ["inspect current state", "apply the narrow repair"],
          verification: ["health and durable state checks pass"],
          failure_signals: ["health remains degraded"],
          safety_boundaries: ["do not claim success without probes"],
          cleanup: ["remove owned temporary probes"],
          evidence_required: ["retain the final health receipt"],
        };
      },
    },
    embedder: { async embedPassage() { return [1, 0]; } },
    store: {
      async vectorSearch() { return []; },
      async store(entry) {
        stored = true;
        return { ...entry, id: "mirror-debt-memory", timestamp: 123 };
      },
    },
    async mdMirror() { throw new Error("injected mirror failure"); },
    logger: { warn(message) { warnings.push(message); } },
    agentEndEvent: { success: true, messages },
  });

  assert.equal(stored, true);
  assert.deepEqual(result, {
    action: "created",
    id: "mirror-debt-memory",
    taskType: "Gateway recovery",
    mirrorStatus: "repair_pending",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /requires repair/);
});
