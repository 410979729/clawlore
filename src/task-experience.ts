import type { LlmClient } from "./llm-client.js";
import type { MemoryEntry, MemorySearchResult, MemoryStore } from "./store.js";
import type { TextEmbedder } from "./embedder.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { redactKnownSecrets } from "./secret-redaction.js";
import {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import {
  agentEndEventAllowsTaskExperience,
  finalAssistantClaimsVerifiedSuccess,
  finalAssistantLooksUnsuccessful,
  summarizeStructuredToolOutcomes,
  type StructuredToolOutcome,
} from "./task-outcome-evidence.js";
import { formatTaskExperienceCapsule } from "./task-experience-capsule.js";
import {
  diagnoseTaskExperienceReview,
  normalizeTaskExperienceReview as normalizeTaskExperienceReviewResponse,
  type TaskExperienceReview,
} from "./task-experience-review.js";

export {
  agentEndEventAllowsTaskExperience,
  finalAssistantClaimsVerifiedSuccess,
  finalAssistantLooksUnsuccessful,
} from "./task-outcome-evidence.js";
export {
  diagnoseTaskExperienceReview,
  type TaskExperienceReview,
  type TaskExperienceReviewDiagnostic,
  type TaskExperienceReviewRejectionReason,
} from "./task-experience-review.js";

type StoreCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";

export interface TaskExperienceCaptureConfig {
  enabled: boolean;
  minMessages: number;
  minToolCalls: number;
  maxInputChars: number;
  maxCapsuleChars: number;
  minConfidence: number;
  dedupeThreshold: number;
}

export interface TaskExperienceTranscript {
  text: string;
  messageCount: number;
  toolLikeCount: number;
  finalAssistantText: string;
  userGoal: string;
  toolNames: string[];
  evidence: string[];
  structuredToolResultCount: number;
  successfulToolResultCount: number;
  failedToolResultCount: number;
  lastStructuredToolOutcome: StructuredToolOutcome | null;
  resolvedFailureToolCount: number;
  unresolvedFailureToolCount: number;
}

export type TaskExperienceCaptureResult =
  | { action: "created"; id: string; taskType: string; mirrorStatus: "not_configured" | "written" | "repair_pending" }
  | { action: "duplicate"; existingId: string; taskType: string; similarity: number }
  | { action: "skipped"; reason: string };

export interface TaskExperienceEpisodeDraft {
  task_class: string;
  task_goal: string;
  user_intent: string;
  status: "open" | "completed" | "failed" | "abandoned";
  outcome: "success" | "failure" | "partial" | "unknown";
  tool_names: string[];
  evidence: string[];
  verification: string[];
  metadata: Record<string, unknown>;
}

export const DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG: TaskExperienceCaptureConfig = {
  enabled: false,
  minMessages: 4,
  minToolCalls: 1,
  maxInputChars: 18_000,
  maxCapsuleChars: 2_400,
  minConfidence: 0.68,
  dedupeThreshold: 0.92,
};

const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 260;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function extractTextFromContent(content: unknown, depth = 0): string {
  if (depth > 4 || content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content.map((item) => extractTextFromContent(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof content !== "object") return "";

  const obj = content as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (/^(image|audio|video|media|file|attachment)$/i.test(type)) {
    return "";
  }

  const direct = ["text", "content", "message", "output", "result", "summary"];
  for (const key of direct) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }

  const parts: string[] = [];
  for (const key of direct) {
    const value = obj[key];
    const text = extractTextFromContent(value, depth + 1);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function getRole(message: unknown): string {
  if (!message || typeof message !== "object") return "unknown";
  const obj = message as Record<string, unknown>;
  const role = obj.role ?? obj.type ?? obj.kind;
  return typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "unknown";
}

function messageLooksToolLike(role: string, text: string): boolean {
  if (role === "tool" || role === "function") return true;
  return /\b(tool_call|function_call|exit_code|Command completed|status=completed|Script running with cell ID)\b/i.test(text);
}

function messageHasToolSignal(message: unknown, role: string, text: string): boolean {
  if (messageLooksToolLike(role, text)) return true;
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    Array.isArray(obj.tool_calls) ||
    Array.isArray(obj.toolCalls) ||
    typeof obj.tool_call_id === "string" ||
    typeof obj.toolCallId === "string" ||
    typeof obj.function_call === "object" ||
    typeof obj.functionCall === "object" ||
    typeof obj.recipient_name === "string" ||
    typeof obj.toolName === "string"
  );
}

function extractToolName(message: unknown, role: string): string {
  if (message && typeof message === "object") {
    const obj = message as Record<string, unknown>;
    for (const key of ["recipient_name", "toolName", "tool_name", "name"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return truncate(compactWhitespace(value), 80);
    }
    const fn = obj.function_call ?? obj.functionCall;
    if (fn && typeof fn === "object") {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return truncate(compactWhitespace(name), 80);
    }
  }
  if (role === "tool" || role === "function") return role;
  return "tool_signal";
}

function pushUnique(list: string[], value: string, limit: number): void {
  const text = truncate(compactWhitespace(value), MAX_ITEM_CHARS);
  if (!text) return;
  const key = text.toLowerCase();
  if (list.some((item) => item.toLowerCase() === key)) return;
  list.push(text);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function redactSensitiveText(value: string): string {
  return sanitizeCaptureText(redactKnownSecrets(value));
}

export function extractTaskExperienceTranscript(
  messages: unknown[],
  maxInputChars = DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxInputChars,
): TaskExperienceTranscript {
  const lines: string[] = [];
  let toolLikeCount = 0;
  let finalAssistantText = "";
  let userGoal = "";
  let messageCount = 0;
  const toolNames: string[] = [];
  const evidence: string[] = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = getRole(message);
    let text = "";
    if (message && typeof message === "object") {
      text = extractTextFromContent((message as Record<string, unknown>).content);
      if (!text) text = extractTextFromContent(message);
    } else {
      text = extractTextFromContent(message);
    }
    text = text.trim();
    const toolSignal = messageHasToolSignal(message, role, text);
    if (!text && !toolSignal) continue;
    const safeText = redactSensitiveText(text);
    messageCount++;
    if (role === "user" && safeText && !userGoal) {
      userGoal = truncate(compactWhitespace(safeText), 320);
    }
    if (toolSignal) {
      toolLikeCount++;
      pushUnique(toolNames, extractToolName(message, role), 12);
      if (safeText) pushUnique(evidence, safeText, 8);
    }
    if (role === "assistant" && safeText) finalAssistantText = safeText;
    lines.push(`${role}: ${truncate(safeText || "[tool signal]", 4000)}`);
  }

  let text = lines.join("\n\n").trim();
  if (text.length > maxInputChars) {
    text = text.slice(-maxInputChars);
  }
  const structured = summarizeStructuredToolOutcomes(messages);
  return {
    text,
    messageCount,
    toolLikeCount,
    finalAssistantText,
    userGoal,
    toolNames,
    evidence,
    structuredToolResultCount: structured.resultCount,
    successfulToolResultCount: structured.successCount,
    failedToolResultCount: structured.failureCount,
    lastStructuredToolOutcome: structured.lastOutcome,
    resolvedFailureToolCount: structured.resolvedFailureToolCount,
    unresolvedFailureToolCount: structured.unresolvedFailureToolCount,
  };
}

export function shouldAttemptTaskExperienceCapture(
  transcript: TaskExperienceTranscript,
  config: TaskExperienceCaptureConfig,
  agentEndEvent?: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (agentEndEvent !== undefined && !agentEndEventAllowsTaskExperience(agentEndEvent)) {
    return { ok: false, reason: "agent_end_not_successful" };
  }
  if (finalAssistantLooksUnsuccessful(transcript.finalAssistantText)) {
    return { ok: false, reason: "final_answer_not_successful" };
  }
  if (transcript.messageCount < config.minMessages) return { ok: false, reason: "too_few_messages" };
  if (transcript.toolLikeCount < config.minToolCalls) return { ok: false, reason: "too_few_tool_signals" };
  if (transcript.structuredToolResultCount < config.minToolCalls) {
    return { ok: false, reason: "structured_tool_outcome_missing" };
  }
  if (transcript.lastStructuredToolOutcome !== "success") {
    return { ok: false, reason: "tool_outcome_not_successful" };
  }
  if (transcript.unresolvedFailureToolCount > 0) {
    // Resolve an earlier failure only when the same explicit tool capability
    // later returns structured success. A success from another tool cannot
    // erase the failed capability's terminal state.
    return { ok: false, reason: "structured_tool_failure_present" };
  }
  // A typed successful agent_end plus terminal structured tool success is
  // sufficient to enter the reviewer. When no typed event is available (for
  // example an offline caller), retain the explicit final-answer verification
  // requirement rather than inferring success from prose or stdout alone.
  if (!finalAssistantClaimsVerifiedSuccess(transcript.finalAssistantText) && agentEndEvent === undefined) {
    return { ok: false, reason: "verified_success_not_established" };
  }
  if (transcript.text.length < 400) return { ok: false, reason: "transcript_too_short" };
  return { ok: true };
}

const NON_EPISODE_SKIP_REASONS = new Set([
  "disabled",
  "too_few_messages",
  "too_few_tool_signals",
  "transcript_too_short",
]);

function resultTaskType(result: TaskExperienceCaptureResult): string {
  return result.action === "skipped" ? "" : result.taskType;
}

function resultReason(result: TaskExperienceCaptureResult): string {
  return result.action === "skipped" ? result.reason : "";
}

function classifyTaskExperienceEpisode(goal: string): string {
  const lowered = goal.toLowerCase();
  if (/claw[-_ ]?lore/.test(lowered)) return "clawlore_task";
  // Persisted Scope Recall task classes remain valid historical compatibility values.
  if (/scope[-_ ]?recall|scoperecall/.test(lowered)) return "scope_recall_task";
  if (/openclaw|gateway/.test(lowered)) return "openclaw_operations";
  if (/config|配置/.test(lowered)) return "config_change";
  if (/debug|repair|fix|排障|修复/.test(lowered)) return "debugging";
  if (/deploy|部署/.test(lowered)) return "deployment";
  if (/migrate|迁移/.test(lowered)) return "migration";
  return "agent_verified_task";
}

function taskExperienceEpisodeOutcome(
  result: TaskExperienceCaptureResult,
): { status: TaskExperienceEpisodeDraft["status"]; outcome: TaskExperienceEpisodeDraft["outcome"] } {
  const incompleteOutcomeReasons = new Set([
    "agent_end_not_successful",
    "final_answer_not_successful",
    "structured_tool_outcome_missing",
    "tool_outcome_not_successful",
    "structured_tool_failure_present",
    "verified_success_not_established",
  ]);
  if (result.action === "skipped" && incompleteOutcomeReasons.has(result.reason)) {
    return { status: "completed", outcome: "partial" };
  }
  return { status: "completed", outcome: "success" };
}

function verificationFromTranscript(
  transcript: TaskExperienceTranscript,
  result: TaskExperienceCaptureResult,
): string[] {
  const verification: string[] = [];
  const combined = [transcript.finalAssistantText, ...transcript.evidence].filter(Boolean);
  for (const item of combined) {
    if (/(verified|verification|passed|pass|ok|healthz|doctor|tested|测试|验证|通过|成功)/iu.test(item)) {
      pushUnique(verification, item, 5);
    }
  }
  if (verification.length === 0 && (result.action === "created" || result.action === "duplicate")) {
    verification.push("Task-experience reviewer accepted the transcript as having concrete verification evidence.");
  }
  return verification;
}

export function shouldRecordTaskExperienceEpisode(
  transcript: TaskExperienceTranscript,
  result: TaskExperienceCaptureResult,
): boolean {
  if (transcript.messageCount < 2 || transcript.toolLikeCount < 1) return false;
  if (result.action !== "skipped") return true;
  return !NON_EPISODE_SKIP_REASONS.has(result.reason);
}

export function buildTaskExperienceEpisodeDraft(params: {
  transcript: TaskExperienceTranscript;
  result: TaskExperienceCaptureResult;
  agentId: string;
}): TaskExperienceEpisodeDraft | null {
  const { transcript, result, agentId } = params;
  if (!shouldRecordTaskExperienceEpisode(transcript, result)) return null;

  const taskGoal = transcript.userGoal || resultTaskType(result) || "Tool-backed agent task";
  const taskClass = resultTaskType(result) || classifyTaskExperienceEpisode(taskGoal);
  const { status, outcome } = taskExperienceEpisodeOutcome(result);
  const finalEvidence = transcript.finalAssistantText
    ? [`final: ${truncate(compactWhitespace(transcript.finalAssistantText), 420)}`]
    : [];
  const evidence = [...transcript.evidence.slice(-5), ...finalEvidence].slice(-6);
  const reason = resultReason(result);
  const reviewerPassed = result.action === "created" || result.action === "duplicate";

  return {
    task_class: taskClass,
    task_goal: truncate(compactWhitespace(taskGoal), 320),
    user_intent: transcript.userGoal,
    status,
    outcome,
    tool_names: transcript.toolNames.length > 0 ? transcript.toolNames : ["tool_signal"],
    evidence,
    verification: verificationFromTranscript(transcript, result),
    metadata: {
      source: "task-experience",
      agent_id: agentId,
      auto_created: true,
      capture_action: result.action,
      capture_reason: reason,
      reviewer_passed: reviewerPassed,
      promotion_eligible: reviewerPassed,
      promotion_review: {
        source: "task-experience-reviewer",
        decision: reviewerPassed ? "approved" : "rejected",
        reason: reviewerPassed ? "reviewer_accepted_reusable_experience" : (reason || "reviewer_not_approved"),
      },
      memory_id: result.action === "created" ? result.id : "",
      existing_memory_id: result.action === "duplicate" ? result.existingId : "",
      similarity: result.action === "duplicate" ? result.similarity : 0,
      mirror_status: result.action === "created" ? result.mirrorStatus : "not_applicable",
      mirror_repair_required: result.action === "created" && result.mirrorStatus === "repair_pending",
    },
  };
}

export function buildTaskExperiencePrompt(transcript: string): string {
  return `Analyze this completed agent task transcript and decide whether it should become a reusable task experience memory.

Only store a capsule when ALL are true:
- The agent completed a real operational/coding/debugging task, not just chat or a one-off explanation.
- The transcript contains a reusable procedure that a weaker model could follow next time.
- The final outcome had concrete success or verification evidence.
- The capsule can be written without raw secrets, credentials, token values, cookie values, or private key material.

Do NOT copy command output, logs, stack traces, full file contents, or channel metadata. Distill the procedure.
If there are secrets, preserve only the safe procedure and safety rule, never the value.
Write the capsule in the dominant language of the transcript.

Return JSON only:
{
  "should_store": true,
  "confidence": 0.0,
  "task_type": "short reusable task label",
  "trigger_phrases": ["phrases that should recall this experience"],
  "applicability": ["when this applies"],
  "preconditions": ["facts/paths/config/services to check before acting"],
  "steps": ["ordered execution steps, concrete but not transcript-noisy"],
  "verification": ["specific pass/fail checks required before claiming success"],
  "failure_signals": ["symptoms that require the fallback branch"],
  "safety_boundaries": ["things not to touch or claims not to make without evidence"],
  "cleanup": ["temporary files/artifacts to clean or preserve"],
  "evidence_required": ["evidence the next model must collect/report"],
  "do_not_store_reason": ""
}

If not worth storing, return:
{
  "should_store": false,
  "confidence": 0,
  "task_type": "",
  "trigger_phrases": [],
  "applicability": [],
  "preconditions": [],
  "steps": [],
  "verification": [],
  "failure_signals": [],
  "safety_boundaries": [],
  "cleanup": [],
  "evidence_required": [],
  "do_not_store_reason": "specific reason"
}

Transcript:
${transcript}`;
}

export function normalizeTaskExperienceReview(
  raw: unknown,
  minConfidence = DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minConfidence,
): TaskExperienceReview | null {
  return normalizeTaskExperienceReviewResponse(raw, minConfidence);
}

function formatBullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"];
}

export function formatTaskExperienceMemoryText(
  review: TaskExperienceReview,
  options: { maxChars?: number } = {},
): string {
  return formatTaskExperienceCapsule({
    taskType: review.task_type,
    triggerPhrases: review.trigger_phrases,
    applicability: review.applicability,
    preconditions: review.preconditions,
    steps: review.steps,
    verification: review.verification,
    failureSignals: review.failure_signals,
    safetyBoundaries: review.safety_boundaries,
    cleanup: review.cleanup,
    evidenceRequired: review.evidence_required,
  }, options.maxChars ?? DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxCapsuleChars);
}

export function isReusableTaskExperience(entry: Pick<MemoryEntry, "metadata" | "text" | "category">): boolean {
  try {
    const metadata = parseSmartMetadata(entry.metadata, entry as MemoryEntry);
    return metadata.type === "reusable-task-experience" || metadata.reusable_task_experience === true;
  } catch {
    return /Reusable Task Experience:/i.test(entry.text || "");
  }
}

function hasReusableTaskExperienceMetadata(result: MemorySearchResult): boolean {
  return isReusableTaskExperience(result.entry);
}

export async function captureTaskExperience(params: {
  messages: unknown[];
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  scope: string;
  config: TaskExperienceCaptureConfig;
  llmClient: LlmClient;
  embedder: TextEmbedder;
  store: MemoryStore;
  mdMirror?: ((entry: { text: string; category: string; scope: string; timestamp?: number }, meta?: { source?: string; agentId?: string }) => Promise<void>) | null;
  logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void };
  agentEndEvent?: unknown;
}): Promise<TaskExperienceCaptureResult> {
  const transcript = extractTaskExperienceTranscript(params.messages, params.config.maxInputChars);
  const gate = shouldAttemptTaskExperienceCapture(transcript, params.config, params.agentEndEvent);
  if (gate.ok !== true) return { action: "skipped", reason: gate.reason };

  const reviewRaw = await params.llmClient.completeJson<unknown>(
    buildTaskExperiencePrompt(transcript.text),
    "task-experience",
  );
  const reviewDiagnostic = diagnoseTaskExperienceReview(reviewRaw, params.config.minConfidence);
  if (!reviewDiagnostic.ok) {
    const failureCategory = typeof params.llmClient.getLastFailure === "function"
      ? params.llmClient.getLastFailure()?.category
      : undefined;
    const reviewerTransportFailed =
      reviewDiagnostic.reason === "review_response_unavailable" &&
      typeof params.llmClient.getLastError === "function" &&
      Boolean(params.llmClient.getLastError());
    const transportReason = (() => {
      if (failureCategory === "authentication") return "review_request_authentication_failed";
      if (failureCategory === "authorization") return "review_request_authorization_failed";
      if (failureCategory === "rate_limit") return "review_request_rate_limited";
      if (failureCategory === "timeout") return "review_request_timed_out";
      if (failureCategory === "endpoint_or_model") return "review_request_endpoint_or_model_failed";
      if (failureCategory === "empty_response" || failureCategory === "invalid_response") {
        return "review_response_invalid";
      }
      return reviewerTransportFailed ? "review_request_failed" : reviewDiagnostic.reason;
    })();
    return {
      action: "skipped",
      reason: transportReason,
    };
  }
  const review = reviewDiagnostic.review;
  if (!review.should_store) {
    // Persist only the stable category. Reviewer prose may paraphrase transcript
    // content and must not become governance-ledger data.
    return { action: "skipped", reason: "review_declined" };
  }

  const untrustedText = formatTaskExperienceMemoryText(review, { maxChars: params.config.maxCapsuleChars });
  const safety = evaluateCaptureSafety(untrustedText);
  if (!safety.allowed) {
    return { action: "skipped", reason: `capture_safety_${safety.reason}` };
  }
  const text = sanitizeCaptureText(untrustedText);
  if (!text) return { action: "skipped", reason: "capture_safety_empty" };

  const vector = await params.embedder.embedPassage(text);
  let existing: MemorySearchResult[] = [];
  try {
    existing = await params.store.vectorSearch(vector, 3, 0.1, [params.scope], { excludeInactive: true });
  } catch (err) {
    params.logger?.warn?.(`task-experience: duplicate pre-check failed, continue store: ${diagnosticErrorSummary(err)}`);
  }

  const duplicate = existing.find((result) =>
    result.score >= params.config.dedupeThreshold &&
    hasReusableTaskExperienceMetadata(result)
  );
  if (duplicate) {
    return {
      action: "duplicate",
      existingId: duplicate.entry.id,
      taskType: review.task_type,
      similarity: duplicate.score,
    };
  }

  const now = Date.now();
  const category: StoreCategory = "other";
  const metadata = stringifySmartMetadata(
    buildSmartMetadata(
      {
        text,
        category,
        importance: 0.88,
      },
      {
        type: "reusable-task-experience",
        reusable_task_experience: true,
        task_type: review.task_type,
        trigger_phrases: review.trigger_phrases,
        applicability: review.applicability,
        preconditions: review.preconditions,
        procedure_steps: review.steps,
        verification_gate: review.verification,
        failure_signals: review.failure_signals,
        safety_boundaries: review.safety_boundaries,
        cleanup: review.cleanup,
        evidence_required: review.evidence_required,
        l0_abstract: `Reusable task experience: ${review.task_type}`,
        l1_overview: [
          `## ${review.task_type}`,
          "",
          "### Trigger Phrases",
          ...formatBullets(review.trigger_phrases),
          "",
          "### Verification",
          ...formatBullets(review.verification),
        ].join("\n"),
        l2_content: text,
        memory_category: "patterns",
        tier: "core",
        access_count: 0,
        confidence: review.confidence,
        source_session: params.sessionKey || params.sessionId || "unknown",
        source: "task-experience",
        state: "confirmed",
        memory_layer: "durable",
        injected_count: 0,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
        valid_from: now,
      },
    ),
  );

  const entry = await params.store.store({
    text,
    vector,
    category,
    scope: params.scope,
    importance: 0.88,
    metadata,
  });

  let mirrorStatus: "not_configured" | "written" | "repair_pending" = "not_configured";
  if (params.mdMirror) {
    try {
      await params.mdMirror(
        { text, category, scope: params.scope, timestamp: entry.timestamp },
        { source: "task-experience", agentId: params.agentId },
      );
      mirrorStatus = "written";
    } catch (error) {
      mirrorStatus = "repair_pending";
      params.logger?.warn?.(`task-experience: markdown mirror projection requires repair: ${diagnosticErrorSummary(error)}`);
    }
  }

  return { action: "created", id: entry.id, taskType: review.task_type, mirrorStatus };
}
