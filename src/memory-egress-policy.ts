import { containsSecret, redactKnownSecrets } from "./secret-redaction.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { isMemoryMetadataSafe } from "./memory-metadata-policy.js";

export interface MemoryEgressEntry {
  text: string;
  metadata?: unknown;
}

/**
 * Redact persisted memory text before it crosses a tool, prompt, diagnostic,
 * or support boundary. The second check is intentionally fail closed in case
 * overlapping secret shapes survive the targeted replacement pass.
 */
export function redactMemoryTextForOutput(text: string | null | undefined): string {
  if (!text) return "";
  const sanitized = sanitizeCaptureText(text);
  const redacted = redactKnownSecrets(sanitized);
  if (containsSecret(redacted)) return "[REDACTED_MEMORY_CONTENT]";
  return evaluateCaptureSafety(redacted).allowed ? redacted : "[REDACTED_MEMORY_CONTENT]";
}

/** Legacy rows predate the persistence gate, so every egress path must filter them. */
export function isMemoryEntrySafeForEgress(entry: MemoryEgressEntry): boolean {
  const normalizedText = entry.text.trim();
  const sanitizedText = sanitizeCaptureText(normalizedText);
  if (sanitizedText !== normalizedText || !evaluateCaptureSafety(sanitizedText).allowed) return false;
  if (entry.metadata == null) return true;
  return isMemoryMetadataSafe(entry.metadata);
}

export function redactMemoryEntryForOutput<
  T extends MemoryEgressEntry & { scope?: string },
>(entry: T): T {
  return {
    ...entry,
    text: redactMemoryTextForOutput(entry.text),
    ...(typeof entry.metadata === "string"
      ? { metadata: redactMemoryTextForOutput(entry.metadata) }
      : entry.metadata == null ? {} : { metadata: "[REDACTED_UNSUPPORTED_METADATA]" }),
    ...(entry.scope ? { scope: redactMemoryTextForOutput(entry.scope) } : {}),
  } as T;
}

export function filterUnsafeMemoryResults<
  T extends { entry: MemoryEgressEntry },
>(results: T[]): T[] {
  return results.filter((result) => isMemoryEntrySafeForEgress(result.entry));
}

export function memoryTextRequiresLocalProcessing(text: string): boolean {
  const normalized = text.trim();
  const sanitized = sanitizeCaptureText(normalized);
  return sanitized !== normalized || !evaluateCaptureSafety(sanitized).allowed;
}
