import { containsSecret } from "../../secret-redaction.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "../../capture-safety.js";
import type {
  MemoryLifecycleV2,
  MemorySourceV2,
  MemoryVerificationV2,
} from "./memory-record.js";
import type { MemoryAddressV2 } from "./memory-address.js";

const INITIAL_LIFECYCLES = new Set<MemoryLifecycleV2>([
  "observed",
  "candidate",
  "active",
  "archived",
]);
const VERIFICATIONS = new Set<MemoryVerificationV2>([
  "unverified",
  "user_confirmed",
  "tool_verified",
  "operator_reviewed",
  "disputed",
]);
const SOURCE_TYPES = new Set<MemorySourceV2["sourceType"]>([
  "user_message",
  "file",
  "tool",
  "extractor",
  "operator",
  "legacy",
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Persistence-bound text is normalized once before role-specific safety
 * checks. This prevents lower-level callers from bypassing the capture and
 * distillation gates with alternate whitespace or boundary characters.
 */
function normalizeBoundedText(
  value: unknown,
  label: string,
  maxLength: number,
  options: { collapseWhitespace?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = options.collapseWhitespace === false
    ? value.trim()
    : value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds the size limit`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} contains invalid boundary characters`);
  }
  return normalized;
}

function assertStructuredTextSafe(value: string, label: string): void {
  if (containsSecret(value)) {
    throw new Error(`${label} rejected by safety policy`);
  }
  const sanitized = sanitizeCaptureText(value);
  if (sanitized !== value) throw new Error(`${label} rejected by safety policy`);
  const safety = evaluateCaptureSafety(sanitized);
  if (!safety.allowed && safety.reason !== "trivial" && safety.reason !== "progress-noise") {
    throw new Error(`${label} rejected by safety policy`);
  }
}

/**
 * Structured identifiers and compact governance fields must not carry
 * credentials, attachment paths, injected context, or operational dumps.
 * Trivial/progress-shaped identifiers remain valid because these fields are
 * not durable natural-language memory content.
 */
export function normalizeTruthIdentifier(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const normalized = normalizeBoundedText(value, label, maxLength);
  assertStructuredTextSafe(normalized, label);
  return normalized;
}

/**
 * Natural-language text entering V2 truth is held to the same final capture
 * policy as V1 truth. Sanitization is not performed silently at this boundary:
 * if an attachment marker or unsafe wrapper would be removed, the write fails.
 */
export function normalizeTruthSemanticText(
  value: unknown,
  label: string,
  maxLength: number,
  options: { collapseWhitespace?: boolean } = {},
): string {
  const normalized = normalizeBoundedText(value, label, maxLength, options);
  const sanitized = sanitizeCaptureText(normalized);
  if (sanitized !== normalized || !evaluateCaptureSafety(sanitized).allowed) {
    throw new Error(`${label} rejected by safety policy`);
  }
  return normalized;
}

export function normalizeOptionalTruthIdentifier(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value == null ? undefined : normalizeTruthIdentifier(value, label, maxLength);
}

const ADDRESS_IDENTIFIER_FIELDS = [
  "tenantId", "principalId", "agentId", "workspaceId", "projectId", "platform",
  "accountId", "conversationId", "threadId", "customerId", "taskId",
] as const satisfies ReadonlyArray<keyof MemoryAddressV2>;

export function assertMemoryAddressIdentifiersSafe(address: MemoryAddressV2): void {
  for (const field of ADDRESS_IDENTIFIER_FIELDS) {
    const value = address[field];
    if (value != null) normalizeTruthIdentifier(value, `memory address ${field}`, 512);
  }
}

export function normalizeInitialLifecycle(value: unknown): MemoryLifecycleV2 {
  const lifecycle = value ?? "active";
  if (typeof lifecycle !== "string" || !INITIAL_LIFECYCLES.has(lifecycle as MemoryLifecycleV2)) {
    throw new Error("initial lifecycle is unsupported");
  }
  return lifecycle as MemoryLifecycleV2;
}

export function normalizeVerification(
  value: unknown,
  fallback: MemoryVerificationV2 = "unverified",
): MemoryVerificationV2 {
  const verification = value ?? fallback;
  if (typeof verification !== "string" || !VERIFICATIONS.has(verification as MemoryVerificationV2)) {
    throw new Error("memory verification is unsupported");
  }
  return verification as MemoryVerificationV2;
}

export function normalizeIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    throw new Error(`${label} must be an ISO-8601 timestamp with a timezone`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

export function normalizeOptionalIsoTimestamp(value: unknown, label: string): string | undefined {
  return value == null ? undefined : normalizeIsoTimestamp(value, label);
}

export function normalizeMemorySource(source: MemorySourceV2): MemorySourceV2 {
  if (!source || typeof source !== "object" || !SOURCE_TYPES.has(source.sourceType)) {
    throw new Error("memory source type is unsupported");
  }
  const sourceId = normalizeOptionalTruthIdentifier(source.sourceId, "memory source id", 512);
  const observedAt = normalizeIsoTimestamp(source.observedAt, "memory source observedAt");
  let evidence: Record<string, unknown> | undefined;
  if (source.evidence != null) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(source.evidence);
    } catch {
      throw new Error("memory source evidence must be JSON serializable");
    }
    if (!serialized || serialized.length > 65_536) {
      throw new Error("memory source evidence exceeds the size limit");
    }
    if (containsSecret(serialized)) {
      throw new Error("memory source evidence rejected by safety policy");
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("memory source evidence must be an object");
    }
    const pending: unknown[] = [parsed];
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === "string") {
        assertStructuredTextSafe(current, "memory source evidence");
      } else if (Array.isArray(current)) {
        pending.push(...current);
      } else if (current && typeof current === "object") {
        pending.push(...Object.values(current as Record<string, unknown>));
      }
    }
    evidence = parsed as Record<string, unknown>;
  }
  return { sourceType: source.sourceType, sourceId, observedAt, evidence };
}
