export interface AutoRecallQueryInput {
  cachedUserMessage?: unknown;
  /**
   * Deprecated unsafe compatibility input. Assembled prompts can contain
   * system instructions, history, and prior memory injection, so automatic
   * recall must never embed them.
   */
  eventPrompt?: unknown;
  maxChars?: number;
}

export interface AutoRecallQuerySelection {
  query: string;
  source: "cached-user-message" | "event-prompt" | "empty";
  originalLength: number;
  truncated: boolean;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function cleanUserRecallQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return compactWhitespace(value.replace(/^(?:@\S+\s*|<@!?\d+>\s*)+/, ""));
}

export function selectAutoRecallQuery(input: AutoRecallQueryInput): AutoRecallQuerySelection {
  const maxChars = Math.max(1, Math.trunc(input.maxChars ?? 1_000));
  const cached = cleanUserRecallQuery(input.cachedUserMessage);
  const source = cached ? "cached-user-message" : "empty";
  const rawQuery = cached;
  const originalLength = rawQuery.length;
  const truncated = originalLength > maxChars;
  return {
    query: truncated ? rawQuery.slice(0, maxChars).trimEnd() : rawQuery,
    source,
    originalLength,
    truncated,
  };
}
