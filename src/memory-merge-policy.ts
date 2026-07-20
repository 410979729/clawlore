import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";

export interface MemoryMergePayload {
  abstract: string;
  overview: string;
  content: string;
}

export type MemoryMergeDecision =
  | { allowed: true; value: MemoryMergePayload }
  | { allowed: false; reason: string };

const MAX_ABSTRACT_CHARS = 1_000;
const MAX_OVERVIEW_CHARS = 8_000;
const MAX_CONTENT_CHARS = 32_000;
const MAX_TOTAL_CHARS = 40_000;

/**
 * Treat merge output as untrusted provider data. Only a bounded, capture-safe
 * payload may cross the subsequent embedding and persistence boundaries.
 */
export function evaluateMemoryMergePayload(input: unknown): MemoryMergeDecision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { allowed: false, reason: "invalid_shape" };
  }

  const raw = input as Record<string, unknown>;
  if (
    typeof raw.abstract !== "string" ||
    typeof raw.overview !== "string" ||
    typeof raw.content !== "string"
  ) {
    return { allowed: false, reason: "invalid_fields" };
  }

  const value: MemoryMergePayload = {
    abstract: sanitizeCaptureText(raw.abstract),
    overview: sanitizeCaptureText(raw.overview),
    content: sanitizeCaptureText(raw.content),
  };
  if (value.abstract.length < 5 || value.content.length < 5) {
    return { allowed: false, reason: "required_text_missing" };
  }
  if (
    value.abstract.length > MAX_ABSTRACT_CHARS ||
    value.overview.length > MAX_OVERVIEW_CHARS ||
    value.content.length > MAX_CONTENT_CHARS ||
    value.abstract.length + value.overview.length + value.content.length > MAX_TOTAL_CHARS
  ) {
    return { allowed: false, reason: "text_too_large" };
  }

  const safety = evaluateCaptureSafety(
    [value.abstract, value.overview, value.content].filter(Boolean).join("\n"),
  );
  if (!safety.allowed) {
    return { allowed: false, reason: `capture_safety_${safety.reason ?? "rejected"}` };
  }
  return { allowed: true, value };
}
