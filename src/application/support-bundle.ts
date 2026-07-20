import { containsSecret } from "../secret-redaction.js";
import { isStructuredSecretKey } from "../secret-structured-text.js";

const SENSITIVE_KEY = /(?:api.?key|token|password|secret|credential|cookie|authorization|private.?key)/i;
const LOCAL_PATH = /(?:^|\s)(?:\/home\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+)/;
const MAX_DEPTH = 16;
const MAX_COLLECTION_ITEMS = 512;

function redactString(value: string): string {
  if (containsSecret(value)) return "<redacted-secret>";
  if (LOCAL_PATH.test(value)) return "<redacted-local-path>";
  return value.length > 4_000 ? `${value.slice(0, 4_000)}<truncated>` : value;
}

function redactSupportBundleValue(
  value: unknown,
  key: string,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (SENSITIVE_KEY.test(key) || isStructuredSecretKey(key)) return "<redacted-secret>";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (depth >= MAX_DEPTH && value && typeof value === "object") return "<redacted-max-depth>";
  if (value && typeof value === "object" && ancestors.has(value)) return "<redacted-circular-reference>";
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result = value.slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => redactSupportBundleValue(item, "", ancestors, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) result.push("<truncated-items>");
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    ancestors.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const result = Object.fromEntries(entries.slice(0, MAX_COLLECTION_ITEMS)
      .map(([childKey, childValue]) => [
        childKey,
        redactSupportBundleValue(childValue, childKey, ancestors, depth + 1),
      ]));
    if (entries.length > MAX_COLLECTION_ITEMS) result.__truncated_entries__ = entries.length - MAX_COLLECTION_ITEMS;
    ancestors.delete(value);
    return result;
  }
  return value;
}

export function redactSupportBundle(value: unknown, key = ""): unknown {
  return redactSupportBundleValue(value, key, new Set<object>(), 0);
}

export function buildSupportBundleV1(input: {
  pluginVersion: string;
  runtimeMode: string;
  diagnostics: Record<string, unknown>;
  generatedAt?: string;
}) {
  return {
    schemaVersion: 1,
    pluginVersion: input.pluginVersion,
    runtimeMode: input.runtimeMode,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    diagnostics: redactSupportBundle(input.diagnostics),
    redactionPolicy: "clawlore-support-v1",
  };
}
