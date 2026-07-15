import { cleanUserRecallQuery, selectAutoRecallQuery, type AutoRecallQuerySelection } from "./auto-recall-query.js";

type RuntimeRecord = Record<string, unknown> | null | undefined;

function firstString(records: RuntimeRecord[], names: string[]): string | undefined {
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const name of names) {
      const value = record[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/**
 * Resolves the narrowest stable runtime boundary shared by channel ingress,
 * prompt construction, and session cleanup. Provider-only identifiers such as
 * `telegram` are deliberately never accepted as a cache key.
 */
export function resolveAutoRecallSessionBoundary(
  event: RuntimeRecord,
  ctx: RuntimeRecord,
): string | undefined {
  const records = [ctx, event];
  const sessionKey = firstString(records, ["sessionKey", "session_key"]);
  if (sessionKey) return `session-key:${sessionKey}`;

  const sessionId = firstString(records, ["sessionId", "session_id"]);
  if (sessionId) return `session-id:${sessionId}`;

  const channelId = firstString(records, ["channelId", "channel", "provider"]);
  const accountId = firstString(records, ["accountId", "account_id"]);
  const conversationId = firstString(records, ["conversationId", "conversation_id", "chatId", "chat_id"]);
  const senderId = firstString(records, ["senderId", "sender_id", "from"]);
  if (!channelId || !accountId || !conversationId || !senderId) return undefined;
  return `boundary:${channelId}:${accountId}:${conversationId}:${senderId}`;
}

export class AutoRecallSessionCache {
  private readonly lastRawUserMessage = new Map<string, string>();

  constructor(private readonly maxEntries = 2_048) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("AutoRecallSessionCache maxEntries must be a positive integer");
    }
  }

  private prune(): void {
    while (this.lastRawUserMessage.size > this.maxEntries) {
      const oldest = this.lastRawUserMessage.keys().next().value;
      if (typeof oldest !== "string") break;
      this.lastRawUserMessage.delete(oldest);
    }
  }

  remember(event: RuntimeRecord, ctx: RuntimeRecord): string | undefined {
    const key = resolveAutoRecallSessionBoundary(event, ctx);
    if (!key) return undefined;
    const raw = typeof event?.content === "string" ? event.content : "";
    const text = cleanUserRecallQuery(raw);
    if (text) {
      this.lastRawUserMessage.delete(key);
      this.lastRawUserMessage.set(key, text);
      this.prune();
    }
    return key;
  }

  select(
    event: RuntimeRecord,
    ctx: RuntimeRecord,
    eventPrompt: unknown,
    maxChars: number,
  ): AutoRecallQuerySelection {
    const key = resolveAutoRecallSessionBoundary(event, ctx);
    return selectAutoRecallQuery({
      cachedUserMessage: key ? this.lastRawUserMessage.get(key) : undefined,
      eventPrompt,
      maxChars,
    });
  }

  clear(event: RuntimeRecord, ctx: RuntimeRecord): string | undefined {
    const key = resolveAutoRecallSessionBoundary(event, ctx);
    if (key) this.lastRawUserMessage.delete(key);
    return key;
  }

  size(): number {
    return this.lastRawUserMessage.size;
  }
}
