import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { containsSecret } from "./secret-redaction.js";

const MAX_METADATA_DEPTH = 16;
const MAX_METADATA_NODES = 8_192;
const SAFE_NON_CONTENT_REASONS = new Set(["empty", "progress-noise", "trivial"]);

interface VisitBudget {
  nodes: number;
}

function isMetadataStringSafe(value: string): boolean {
  const normalized = value.trim();
  if (sanitizeCaptureText(value) !== normalized) return false;
  const decision = evaluateCaptureSafety(value);
  return decision.allowed || (decision.reason != null && SAFE_NON_CONTENT_REASONS.has(decision.reason));
}

function visitMetadata(value: unknown, depth: number, budget: VisitBudget): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) return false;
  if (value == null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isMetadataStringSafe(value);
  if (Array.isArray(value)) {
    return value.every((item) => visitMetadata(item, depth + 1, budget));
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) => key.length <= 512 && isMetadataStringSafe(key)
      && visitMetadata(item, depth + 1, budget),
  );
}

/**
 * Validate persisted metadata as bounded JSON data rather than opaque text.
 * Content-like strings must satisfy the same attachment, injected-context,
 * private-path, and Secret boundaries as memory text. Short state/identifier
 * values such as `done` remain valid metadata even though they are not useful
 * standalone memories.
 */
export function isMemoryMetadataSafe(metadata: unknown): boolean {
  let parsed = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let serialized: string;
  try {
    serialized = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
  } catch {
    return false;
  }
  if (containsSecret(serialized)) return false;
  return visitMetadata(parsed, 0, { nodes: 0 });
}

export function assertMemoryMetadataSafe(metadata: unknown): void {
  if (!isMemoryMetadataSafe(metadata)) {
    throw new Error("memory metadata rejected by safety policy");
  }
}
