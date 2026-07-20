import { findSecret } from "./secret-redaction.js";

export type CaptureSafetyReason =
  | "empty"
  | "injected-context"
  | "system-wrapper"
  | "context-compaction"
  | "operational-trace"
  | "private-path"
  | "progress-noise"
  | "secret"
  | "trivial";

export interface CaptureSafetyDecision {
  allowed: boolean;
  reason?: CaptureSafetyReason;
  pattern?: string;
}

const INJECTED_CONTEXT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "relevant-memories", re: /<\/?relevant-memories>/i },
  { name: "untrusted-data-block", re: /\[UNTRUSTED DATA[^\]]*\][\s\S]*?\[END UNTRUSTED DATA\]/i },
  { name: "openclaw-runtime-context", re: /OpenClaw runtime context for this turn:/i },
  { name: "workspace-context", re: /## OpenClaw Workspace Context/i },
  { name: "conversation-metadata", re: /Conversation info \(untrusted metadata\):/i },
  { name: "sender-metadata", re: /Sender \(untrusted metadata\):/i },
  { name: "message-metadata-json", re: /```json[\s\S]*"message_id"[\s\S]*"sender_id"[\s\S]*```/i },
];

const SYSTEM_WRAPPER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "system-exec-line", re: /^System:\s*\[[^\n]*\]\s*Exec\s+(?:completed|failed|started)\b/im },
  { name: "session-reset-wrapper", re: /^A new session was started via \/new or \/reset\./i },
  { name: "current-user-request-wrapper", re: /^Current user request:/im },
];

const OPERATIONAL_TRACE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "command-hints-block", re: /^Command hints:\s*[\s\S]*?(?:^Files:|^Result:|\|\s*status=)/im },
  { name: "execution-status-marker", re: /\|\s*status=(?:completed|failed|running|cancelled)\b/i },
  { name: "execution-result-block", re: /^Result:\s*(?:Command|Task|Exec|Shell|Tool)\b/im },
  { name: "tool-fields-block", re: /^(?:Files|Result):\s*[\s\S]*\n(?:Files|Result|Command hints):/im },
  { name: "tool-call-json", re: /```json[\s\S]*"(?:tool_call_id|recipient_name|sandbox_permissions|wall_time_seconds)"[\s\S]*```/i },
  { name: "tool-output-dump", re: /^(?:stdout|stderr|exit_code|wall_time_seconds|original_token_count):\s*/im },
];

const CONTEXT_COMPACTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "turn-context-split", re: /Turn Context \(split turn\):/i },
  { name: "compaction-summary", re: /^## (?:Goal|Progress|Decisions|Open TODOs|Constraints\/Rules|Pending user asks|Exact identifiers)\b/m },
  { name: "critical-context-block", re: /^## Critical Context\b/m },
];

const PRIVATE_PATH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "credentials-path", re: /(?:^|\s)(?:~|\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)[^\s`'"]*(?:\.credentials|credentials|credential|secret|token|cookie|oauth|vault|id_rsa|id_ed25519)[^\s`'"]*/i },
  { name: "ssh-private-material-path", re: /(?:^|\s)(?:~|\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)[^\s`'"]*\.ssh[^\s`'"]*/i },
  { name: "local-scratch-sensitive-path", re: /(?:^|\s)(?:\/tmp|\/var\/tmp|[A-Za-z]:\\Temp\\|[A-Za-z]:\\Windows\\Temp\\)[^\s`'"]*(?:credential|secret|token|cookie|oauth|vault|password|private[_-]?key)[^\s`'"]*/i },
];

const PROGRESS_NOISE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "assistant-progress-cn", re: /^(?:我)?(?:先|现在|继续|马上|接下来)?(?:开始|正在|继续|准备|会|把|先把).{0,80}(?:排查|定位|读取|检查|修改|修复|验证|审计|同步|跑测试|收口).{0,80}(?:。|\.|$)/iu },
  { name: "assistant-progress-en", re: /^(?:i[' ]?m|i am|i will|next i(?:'ll| will)?|now i(?:'ll| will)?)\s+(?:checking|reading|patching|testing|verifying|auditing|syncing|investigating|updating)\b.{0,120}$/i },
];

/**
 * Attachment line patterns — matched against trimmed lines for full-line removal.
 */
const ATTACHMENT_LINE_PATTERNS: RegExp[] = [
  /^\[Image attached at:\s*.*\]\s*$/i,
  /^\[inline image\/[^\]]*data omitted\]\s*$/i,
  /^\[screenshot\]\s*$/i,
];

/**
 * Inline attachment patterns — matched within lines for partial removal.
 */
const INLINE_ATTACHMENT_PATTERNS: RegExp[] = [
  /\[Image attached at:\s*[^\]]*\]/gi,
  /\[inline image\/[^\]]*data omitted\]/gi,
  /\[screenshot\]/gi,
  /(?:[A-Za-z]:)?[^\s\]]*[/\\]image_cache[/\\]img_[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)\b/gi,
];

/**
 * Trivial/ACK pattern — matches short acknowledgements that should not enter journal.
 */
const TRIVIAL_RE = /^(?:ok|okay|kk|k|yes|no|yep|nope|sure|thanks|thank you|thx|ty|got it|roger|understood|noted|acknowledged|done|hi|hello|hey|yo|早|早安|你好|嗨|在吗|在嗎|谢谢|謝謝|收到|明白|明白了|了解|了解了|好的|好)(?:[!！,.。?？~\s]*)$/i;

function matchPattern(
  patterns: Array<{ name: string; re: RegExp }>,
  text: string,
): { name: string } | null {
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return { name: pattern.name };
  }
  return null;
}

/**
 * Sanitize text by removing gateway attachment markers before capture/journal storage.
 *
 * The LLM may receive images through native vision paths, but scope-recall should not
 * persist local cache paths or inline-image placeholders as memory material. Keeps the
 * user's surrounding text so a screenshot question can still be represented.
 */
export function sanitizeCaptureText(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.trim();
  if (!cleaned) return "";

  const keptLines: string[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const stripped = line.trim();
    // Skip full-line attachment markers
    if (ATTACHMENT_LINE_PATTERNS.some((p) => p.test(stripped))) {
      continue;
    }
    // Remove inline attachment markers
    let sanitizedLine = line.trimEnd();
    for (const pattern of INLINE_ATTACHMENT_PATTERNS) {
      sanitizedLine = sanitizedLine.replace(pattern, "");
    }
    // Collapse multiple spaces within the line
    sanitizedLine = sanitizedLine.replace(/[ \t]{2,}/g, " ").trim();
    // Keep the line (even if empty, to preserve paragraph structure)
    keptLines.push(sanitizedLine);
  }
  const sanitized = keptLines.join("\n").trim();
  return sanitized.replace(/\n{3,}/g, "\n\n");
}

/**
 * Check if text is a trivial acknowledgement that should not enter journal.
 */
export function isTrivial(text: string): boolean {
  return TRIVIAL_RE.test((text || "").trim());
}

export function evaluateCaptureSafety(text: string): CaptureSafetyDecision {
  // Sanitize attachment markers first
  const sanitized = sanitizeCaptureText(text);
  if (!sanitized) return { allowed: false, reason: "empty" };

  // Check trivial/ACK
  if (isTrivial(sanitized)) {
    return { allowed: false, reason: "trivial" };
  }

  const injected = matchPattern(INJECTED_CONTEXT_PATTERNS, sanitized);
  if (injected) {
    return { allowed: false, reason: "injected-context", pattern: injected.name };
  }

  const wrapper = matchPattern(SYSTEM_WRAPPER_PATTERNS, sanitized);
  if (wrapper) {
    return { allowed: false, reason: "system-wrapper", pattern: wrapper.name };
  }

  const operationalTrace = matchPattern(OPERATIONAL_TRACE_PATTERNS, sanitized);
  if (operationalTrace) {
    return { allowed: false, reason: "operational-trace", pattern: operationalTrace.name };
  }

  const privatePath = matchPattern(PRIVATE_PATH_PATTERNS, sanitized);
  if (privatePath) {
    return { allowed: false, reason: "private-path", pattern: privatePath.name };
  }

  const progressNoise = matchPattern(PROGRESS_NOISE_PATTERNS, sanitized);
  if (progressNoise) {
    return { allowed: false, reason: "progress-noise", pattern: progressNoise.name };
  }

  const compaction = matchPattern(CONTEXT_COMPACTION_PATTERNS, sanitized);
  if (compaction) {
    return { allowed: false, reason: "context-compaction", pattern: compaction.name };
  }

  const secret = findSecret(sanitized);
  if (secret) {
    return { allowed: false, reason: "secret", pattern: secret.name };
  }

  return { allowed: true };
}

export function isCaptureSafeText(text: string): boolean {
  return evaluateCaptureSafety(text).allowed;
}
