import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { redactKnownSecrets } from "./secret-redaction.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata, } from "./smart-metadata.js";
import { agentEndEventAllowsTaskExperience, finalAssistantClaimsVerifiedSuccess, finalAssistantLooksUnsuccessful, summarizeStructuredToolOutcomes, } from "./task-outcome-evidence.js";
import { formatTaskExperienceCapsule } from "./task-experience-capsule.js";
export { agentEndEventAllowsTaskExperience, finalAssistantClaimsVerifiedSuccess, finalAssistantLooksUnsuccessful, } from "./task-outcome-evidence.js";
export const DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG = {
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
function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function truncate(value, maxChars) {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars)
        return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function asStringList(value) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== "string")
            continue;
        const text = truncate(compactWhitespace(item), MAX_ITEM_CHARS);
        if (!text || seen.has(text.toLowerCase()))
            continue;
        seen.add(text.toLowerCase());
        out.push(text);
        if (out.length >= MAX_LIST_ITEMS)
            break;
    }
    return out;
}
function extractTextFromContent(content, depth = 0) {
    if (depth > 4 || content == null)
        return "";
    if (typeof content === "string")
        return content;
    if (typeof content === "number" || typeof content === "boolean")
        return String(content);
    if (Array.isArray(content)) {
        return content.map((item) => extractTextFromContent(item, depth + 1)).filter(Boolean).join("\n");
    }
    if (typeof content !== "object")
        return "";
    const obj = content;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (/^(image|audio|video|media|file|attachment)$/i.test(type)) {
        return "";
    }
    const direct = ["text", "content", "message", "output", "result", "summary"];
    for (const key of direct) {
        const value = obj[key];
        if (typeof value === "string")
            return value;
    }
    const parts = [];
    for (const key of direct) {
        const value = obj[key];
        const text = extractTextFromContent(value, depth + 1);
        if (text)
            parts.push(text);
    }
    return parts.join("\n");
}
function getRole(message) {
    if (!message || typeof message !== "object")
        return "unknown";
    const obj = message;
    const role = obj.role ?? obj.type ?? obj.kind;
    return typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "unknown";
}
function messageLooksToolLike(role, text) {
    if (role === "tool" || role === "function")
        return true;
    return /\b(tool_call|function_call|exit_code|Command completed|status=completed|Script running with cell ID)\b/i.test(text);
}
function messageHasToolSignal(message, role, text) {
    if (messageLooksToolLike(role, text))
        return true;
    if (!message || typeof message !== "object")
        return false;
    const obj = message;
    return (Array.isArray(obj.tool_calls) ||
        Array.isArray(obj.toolCalls) ||
        typeof obj.tool_call_id === "string" ||
        typeof obj.toolCallId === "string" ||
        typeof obj.function_call === "object" ||
        typeof obj.functionCall === "object" ||
        typeof obj.recipient_name === "string" ||
        typeof obj.toolName === "string");
}
function extractToolName(message, role) {
    if (message && typeof message === "object") {
        const obj = message;
        for (const key of ["recipient_name", "toolName", "tool_name", "name"]) {
            const value = obj[key];
            if (typeof value === "string" && value.trim())
                return truncate(compactWhitespace(value), 80);
        }
        const fn = obj.function_call ?? obj.functionCall;
        if (fn && typeof fn === "object") {
            const name = fn.name;
            if (typeof name === "string" && name.trim())
                return truncate(compactWhitespace(name), 80);
        }
    }
    if (role === "tool" || role === "function")
        return role;
    return "tool_signal";
}
function pushUnique(list, value, limit) {
    const text = truncate(compactWhitespace(value), MAX_ITEM_CHARS);
    if (!text)
        return;
    const key = text.toLowerCase();
    if (list.some((item) => item.toLowerCase() === key))
        return;
    list.push(text);
    if (list.length > limit)
        list.splice(0, list.length - limit);
}
function redactSensitiveText(value) {
    return sanitizeCaptureText(redactKnownSecrets(value));
}
export function extractTaskExperienceTranscript(messages, maxInputChars = DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxInputChars) {
    const lines = [];
    let toolLikeCount = 0;
    let finalAssistantText = "";
    let userGoal = "";
    let messageCount = 0;
    const toolNames = [];
    const evidence = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        const role = getRole(message);
        let text = "";
        if (message && typeof message === "object") {
            text = extractTextFromContent(message.content);
            if (!text)
                text = extractTextFromContent(message);
        }
        else {
            text = extractTextFromContent(message);
        }
        text = text.trim();
        const toolSignal = messageHasToolSignal(message, role, text);
        if (!text && !toolSignal)
            continue;
        const safeText = redactSensitiveText(text);
        messageCount++;
        if (role === "user" && safeText && !userGoal) {
            userGoal = truncate(compactWhitespace(safeText), 320);
        }
        if (toolSignal) {
            toolLikeCount++;
            pushUnique(toolNames, extractToolName(message, role), 12);
            if (safeText)
                pushUnique(evidence, safeText, 8);
        }
        if (role === "assistant" && safeText)
            finalAssistantText = safeText;
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
    };
}
export function shouldAttemptTaskExperienceCapture(transcript, config, agentEndEvent) {
    if (!config.enabled)
        return { ok: false, reason: "disabled" };
    if (agentEndEvent !== undefined && !agentEndEventAllowsTaskExperience(agentEndEvent)) {
        return { ok: false, reason: "agent_end_not_successful" };
    }
    if (finalAssistantLooksUnsuccessful(transcript.finalAssistantText)) {
        return { ok: false, reason: "final_answer_not_successful" };
    }
    if (transcript.messageCount < config.minMessages)
        return { ok: false, reason: "too_few_messages" };
    if (transcript.toolLikeCount < config.minToolCalls)
        return { ok: false, reason: "too_few_tool_signals" };
    if (transcript.structuredToolResultCount < config.minToolCalls) {
        return { ok: false, reason: "structured_tool_outcome_missing" };
    }
    if (transcript.lastStructuredToolOutcome !== "success") {
        return { ok: false, reason: "tool_outcome_not_successful" };
    }
    if (transcript.failedToolResultCount > 0) {
        // Task Experience is optional and must fail closed. Without a reliable
        // operation/call correlation model, a later unrelated success cannot be
        // assumed to resolve an earlier structured failure.
        return { ok: false, reason: "structured_tool_failure_present" };
    }
    if (!finalAssistantClaimsVerifiedSuccess(transcript.finalAssistantText)) {
        return { ok: false, reason: "verified_success_not_established" };
    }
    if (transcript.text.length < 400)
        return { ok: false, reason: "transcript_too_short" };
    return { ok: true };
}
const NON_EPISODE_SKIP_REASONS = new Set([
    "disabled",
    "too_few_messages",
    "too_few_tool_signals",
    "transcript_too_short",
]);
function resultTaskType(result) {
    return result.action === "skipped" ? "" : result.taskType;
}
function resultReason(result) {
    return result.action === "skipped" ? result.reason : "";
}
function classifyTaskExperienceEpisode(goal) {
    const lowered = goal.toLowerCase();
    if (/claw[-_ ]?lore/.test(lowered))
        return "clawlore_task";
    // Persisted Scope Recall task classes remain valid historical compatibility values.
    if (/scope[-_ ]?recall|scoperecall/.test(lowered))
        return "scope_recall_task";
    if (/openclaw|gateway/.test(lowered))
        return "openclaw_operations";
    if (/config|配置/.test(lowered))
        return "config_change";
    if (/debug|repair|fix|排障|修复/.test(lowered))
        return "debugging";
    if (/deploy|部署/.test(lowered))
        return "deployment";
    if (/migrate|迁移/.test(lowered))
        return "migration";
    return "agent_verified_task";
}
function taskExperienceEpisodeOutcome(result) {
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
function verificationFromTranscript(transcript, result) {
    const verification = [];
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
export function shouldRecordTaskExperienceEpisode(transcript, result) {
    if (transcript.messageCount < 2 || transcript.toolLikeCount < 1)
        return false;
    if (result.action !== "skipped")
        return true;
    return !NON_EPISODE_SKIP_REASONS.has(result.reason);
}
export function buildTaskExperienceEpisodeDraft(params) {
    const { transcript, result, agentId } = params;
    if (!shouldRecordTaskExperienceEpisode(transcript, result))
        return null;
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
export function buildTaskExperiencePrompt(transcript) {
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
export function normalizeTaskExperienceReview(raw, minConfidence = DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minConfidence) {
    if (!raw || typeof raw !== "object")
        return null;
    const obj = raw;
    const confidence = clampNumber(obj.confidence, 0, 0, 1);
    const review = {
        should_store: obj.should_store === true,
        confidence,
        task_type: truncate(compactWhitespace(typeof obj.task_type === "string" ? obj.task_type : ""), 140),
        trigger_phrases: asStringList(obj.trigger_phrases),
        applicability: asStringList(obj.applicability),
        preconditions: asStringList(obj.preconditions),
        steps: asStringList(obj.steps),
        verification: asStringList(obj.verification),
        failure_signals: asStringList(obj.failure_signals),
        safety_boundaries: asStringList(obj.safety_boundaries),
        cleanup: asStringList(obj.cleanup),
        evidence_required: asStringList(obj.evidence_required),
        do_not_store_reason: typeof obj.do_not_store_reason === "string"
            ? truncate(compactWhitespace(obj.do_not_store_reason), 300)
            : undefined,
    };
    if (!review.should_store)
        return review;
    if (review.confidence < minConfidence)
        return null;
    if (!review.task_type)
        return null;
    if (review.steps.length < 2)
        return null;
    if (review.verification.length < 1)
        return null;
    return review;
}
function formatBullets(items) {
    return items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"];
}
export function formatTaskExperienceMemoryText(review, options = {}) {
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
export function isReusableTaskExperience(entry) {
    try {
        const metadata = parseSmartMetadata(entry.metadata, entry);
        return metadata.type === "reusable-task-experience" || metadata.reusable_task_experience === true;
    }
    catch {
        return /Reusable Task Experience:/i.test(entry.text || "");
    }
}
function hasReusableTaskExperienceMetadata(result) {
    return isReusableTaskExperience(result.entry);
}
export async function captureTaskExperience(params) {
    const transcript = extractTaskExperienceTranscript(params.messages, params.config.maxInputChars);
    const gate = shouldAttemptTaskExperienceCapture(transcript, params.config, params.agentEndEvent);
    if (gate.ok !== true)
        return { action: "skipped", reason: gate.reason };
    const reviewRaw = await params.llmClient.completeJson(buildTaskExperiencePrompt(transcript.text), "task-experience");
    const review = normalizeTaskExperienceReview(reviewRaw, params.config.minConfidence);
    if (!review)
        return { action: "skipped", reason: "review_invalid_or_low_confidence" };
    if (!review.should_store) {
        return { action: "skipped", reason: review.do_not_store_reason || "review_declined" };
    }
    const untrustedText = formatTaskExperienceMemoryText(review, { maxChars: params.config.maxCapsuleChars });
    const safety = evaluateCaptureSafety(untrustedText);
    if (!safety.allowed) {
        return { action: "skipped", reason: `capture_safety_${safety.reason}` };
    }
    const text = sanitizeCaptureText(untrustedText);
    if (!text)
        return { action: "skipped", reason: "capture_safety_empty" };
    const vector = await params.embedder.embedPassage(text);
    let existing = [];
    try {
        existing = await params.store.vectorSearch(vector, 3, 0.1, [params.scope], { excludeInactive: true });
    }
    catch (err) {
        params.logger?.warn?.(`task-experience: duplicate pre-check failed, continue store: ${diagnosticErrorSummary(err)}`);
    }
    const duplicate = existing.find((result) => result.score >= params.config.dedupeThreshold &&
        hasReusableTaskExperienceMetadata(result));
    if (duplicate) {
        return {
            action: "duplicate",
            existingId: duplicate.entry.id,
            taskType: review.task_type,
            similarity: duplicate.score,
        };
    }
    const now = Date.now();
    const category = "other";
    const metadata = stringifySmartMetadata(buildSmartMetadata({
        text,
        category,
        importance: 0.88,
    }, {
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
    }));
    const entry = await params.store.store({
        text,
        vector,
        category,
        scope: params.scope,
        importance: 0.88,
        metadata,
    });
    let mirrorStatus = "not_configured";
    if (params.mdMirror) {
        try {
            await params.mdMirror({ text, category, scope: params.scope, timestamp: entry.timestamp }, { source: "task-experience", agentId: params.agentId });
            mirrorStatus = "written";
        }
        catch (error) {
            mirrorStatus = "repair_pending";
            params.logger?.warn?.(`task-experience: markdown mirror projection requires repair: ${diagnosticErrorSummary(error)}`);
        }
    }
    return { action: "created", id: entry.id, taskType: review.task_type, mirrorStatus };
}
