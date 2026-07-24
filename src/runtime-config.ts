import {
  CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS,
  CLAWLORE_RUNTIME_CONFIG_KEY,
} from "./product-identity.js";

/**
 * Runtime request controls for the current ClawLore architecture.
 *
 * These controls can register a read-only shadow observer. They never grant
 * write, prompt-mutation, ContextEngine, lifecycle, or final-recall authority.
 */
export interface ClawLoreRuntimeRequestConfig {
  mode?: "auto" | "disabled" | "shadow" | "v2-write" | "cutover";
  contextEngine?: "compatibility" | "native-opt-in";
  tokenBudget?: number;
  maxLatencyMs?: number;
  traceFile?: string;
  maxTraceBytes?: number;
  maxQueryChars?: number;
  candidateLimit?: number;
  maxConcurrent?: number;
  readinessFile?: string;
  /** Deprecated compatibility input. Parsed but never used as an activation gate. */
  approvalFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function intBetween(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= min && integer <= max ? integer : fallback;
}

function normalizeRuntimeRequest(raw: Record<string, unknown>): ClawLoreRuntimeRequestConfig {
  return {
    mode: ["disabled", "shadow", "v2-write", "cutover"].includes(String(raw.mode))
      ? raw.mode as "disabled" | "shadow" | "v2-write" | "cutover"
      : "auto",
    contextEngine: raw.contextEngine === "native-opt-in" ? "native-opt-in" : "compatibility",
    tokenBudget: intBetween(raw.tokenBudget, 32, 32_768, 512),
    maxLatencyMs: intBetween(raw.maxLatencyMs, 25, 5_000, 750),
    traceFile: asNonEmptyString(raw.traceFile),
    maxTraceBytes: intBetween(raw.maxTraceBytes, 16_384, 100_000_000, 5_000_000),
    maxQueryChars: intBetween(raw.maxQueryChars, 256, 12_000, 4_000),
    candidateLimit: intBetween(raw.candidateLimit, 1, 20, 6),
    maxConcurrent: intBetween(raw.maxConcurrent, 1, 16, 2),
    readinessFile: asNonEmptyString(raw.readinessFile),
    approvalFile: asNonEmptyString(raw.approvalFile),
  };
}

function sameRuntimeRequest(
  left: ClawLoreRuntimeRequestConfig,
  right: ClawLoreRuntimeRequestConfig,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolves the canonical `runtime` object and the deprecated `clawloreV2`
 * alias into one internal contract. If both keys are present they must
 * normalize to the same value; ambiguity fails before hook registration.
 */
export function resolveClawLoreRuntimeRequestConfig(
  value: unknown,
): ClawLoreRuntimeRequestConfig | undefined {
  if (!isRecord(value)) return undefined;

  const canonicalPresent = Object.hasOwn(value, CLAWLORE_RUNTIME_CONFIG_KEY);
  const legacyKey = CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS[0];
  const legacyPresent = Object.hasOwn(value, legacyKey);
  const canonicalRaw = value[CLAWLORE_RUNTIME_CONFIG_KEY];
  const legacyRaw = value[legacyKey];

  if (canonicalPresent && !isRecord(canonicalRaw)) {
    throw new Error("ClawLore runtime configuration must be an object");
  }
  if (legacyPresent && !isRecord(legacyRaw)) {
    throw new Error("Deprecated ClawLore runtime configuration must be an object");
  }

  const canonical = isRecord(canonicalRaw) ? normalizeRuntimeRequest(canonicalRaw) : undefined;
  const legacy = isRecord(legacyRaw) ? normalizeRuntimeRequest(legacyRaw) : undefined;
  if (canonical && legacy && !sameRuntimeRequest(canonical, legacy)) {
    throw new Error("Conflicting ClawLore runtime and deprecated clawloreV2 configuration");
  }
  return canonical ?? legacy;
}
