import { redactMemoryTextForOutput } from "./memory-egress-policy.js";

const REDACTED_MEMORY_CONTENT = "[REDACTED_MEMORY_CONTENT]";
const REDACTED_UNSAFE_CONTENT = "[REDACTED_UNSAFE_CONTENT]";
const RESERVED_MARKDOWN_LINE = /^(?:#{1,6}\s|\*\*(?:Logged|Priority|Status|Area)\*\*\s*:|---\s*$)/u;

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > maxLength) throw new Error(`${label} exceeds the size limit`);
  return value;
}

function escapeStructuredLines(value: string): string {
  return value.split(/\r?\n/u).map((line) => {
    const leading = line.match(/^\s*/u)?.[0] ?? "";
    const content = line.slice(leading.length);
    return RESERVED_MARKDOWN_LINE.test(content) ? `${leading}\\${content}` : line;
  }).join("\n");
}

export function normalizeSelfImprovementSummary(value: unknown): string {
  const raw = requireBoundedString(value, "learning summary", 1_000).trim();
  if (!raw) throw new Error("learning summary is required");
  const safe = redactMemoryTextForOutput(raw);
  if (!safe || safe === REDACTED_MEMORY_CONTENT) {
    throw new Error("learning summary rejected by safety policy");
  }
  return escapeStructuredLines(safe).replace(/\s+/gu, " ").trim();
}

export function normalizeSelfImprovementBody(
  value: unknown,
  label: string,
  maxLength: number,
  fallback = "-",
): string {
  const raw = requireBoundedString(value, label, maxLength).trim();
  if (!raw) return fallback;
  const safe = redactMemoryTextForOutput(raw);
  if (!safe || safe === REDACTED_MEMORY_CONTENT) return REDACTED_UNSAFE_CONTENT;
  return escapeStructuredLines(safe);
}

export function normalizeSelfImprovementLabel(
  value: unknown,
  label: string,
  fallback: string,
): string {
  const raw = requireBoundedString(value, label, 256).trim();
  if (!raw) return fallback;
  const safe = redactMemoryTextForOutput(raw).replace(/\s+/gu, " ").trim();
  if (!safe || safe === REDACTED_MEMORY_CONTENT) return fallback;
  return safe.replace(/[`*_[\]<>]/gu, "").slice(0, 256) || fallback;
}
