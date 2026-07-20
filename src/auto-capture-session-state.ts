import { normalizeAutoCaptureText } from "./auto-capture-cleanup.js";

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_RECENT_TEXT_LIMIT = 6;
const EXPLICIT_REMEMBER_RE = /^(?:请|請)?(?:记住|記住|记一下|記一下|别忘了|別忘了)[。.!?？!]*$/u;

export interface AutoCaptureMessageSelection {
  eligibleTexts: string[];
  newTexts: string[];
  texts: string[];
  pendingIngressCount: number;
  skippedTextCount: number;
}

export interface AutoCaptureSessionStateOptions {
  maxEntries?: number;
  recentTextLimit?: number;
}

type ShouldSkipMessage = (role: string, text: string) => boolean;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function pruneOldest<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function buildAutoCaptureConversationKeyFromIngress(
  channelId: string | undefined,
  conversationId: string | undefined,
  accountId?: string,
  chatType?: string,
): string | null {
  const channel = typeof channelId === "string" ? channelId.trim() : "";
  const conversation = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!channel || !conversation) return null;
  const account = typeof accountId === "string" ? accountId.trim() : "";
  const kindValue = typeof chatType === "string" ? chatType.trim().toLowerCase() : "";
  const kind = kindValue === "dm" || kindValue === "private" ? "direct" : kindValue;
  return account && ["direct", "group", "channel"].includes(kind)
    ? `${channel}:${account}:${kind}:${conversation}`
    : `${channel}:${conversation}`;
}

/**
 * OpenClaw session keys use `agent:<agentId>:<channel>:<conversation...>`.
 * The channel/conversation suffix intentionally matches the ingress key while
 * preserving any additional colon-delimited group or thread components.
 */
export function buildAutoCaptureConversationKeyFromSessionKey(sessionKey: string): string | null {
  const match = /^agent:[^:]+:(.+)$/.exec(sessionKey.trim());
  const suffix = match?.[1]?.trim();
  return suffix || null;
}

function buildExactAutoCaptureSessionKey(sessionKey: string | undefined): string | null {
  const normalized = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return normalized ? `session:${normalized}` : null;
}

export function extractAutoCaptureEligibleTexts(params: {
  messages: unknown[];
  captureAssistant: boolean;
  shouldSkipMessage?: ShouldSkipMessage;
}): { eligibleTexts: string[]; skippedTextCount: number } {
  const eligibleTexts: string[] = [];
  let skippedTextCount = 0;

  const append = (role: string, text: string) => {
    const normalized = normalizeAutoCaptureText(role, text, params.shouldSkipMessage);
    if (normalized) eligibleTexts.push(normalized);
    else skippedTextCount += 1;
  };

  for (const message of params.messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== "user" && !(params.captureAssistant && role === "assistant")) continue;

    if (typeof record.content === "string") {
      append(role, record.content);
      continue;
    }
    if (!Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      const textBlock = block as Record<string, unknown>;
      if (textBlock.type === "text" && typeof textBlock.text === "string") append(role, textBlock.text);
    }
  }
  return { eligibleTexts, skippedTextCount };
}

function consumePendingPrefix(pending: string[], eligibleTexts: string[]): {
  consumed: string[];
  remaining: string[];
} {
  if (pending.length === 0) return { consumed: [], remaining: [] };
  const available = new Map<string, number>();
  for (const text of eligibleTexts) available.set(text, (available.get(text) ?? 0) + 1);
  let consumedCount = 0;
  for (const text of pending) {
    const count = available.get(text) ?? 0;
    if (count <= 0) break;
    consumedCount += 1;
    if (count === 1) available.delete(text);
    else available.set(text, count - 1);
  }

  // Some OpenClaw builds expose an agent_end snapshot that trails the ingress
  // hook. Preserve that compatibility by consuming the oldest pending message,
  // but never drain later turns that the snapshot cannot prove belong here.
  if (consumedCount === 0) consumedCount = 1;
  return {
    consumed: pending.slice(0, consumedCount),
    remaining: pending.slice(consumedCount),
  };
}

/**
 * Owns the bounded, cross-hook conversation cursor used by auto-capture.
 * It never resolves access, chooses scope, calls a model, or writes memory.
 */
export class AutoCaptureSessionState {
  private readonly maxEntries: number;
  private readonly recentTextLimit: number;
  private readonly seenTextCount = new Map<string, number>();
  private readonly pendingIngressTexts = new Map<string, string[]>();
  private readonly recentTexts = new Map<string, string[]>();

  constructor(options: AutoCaptureSessionStateOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.recentTextLimit = positiveInteger(options.recentTextLimit, DEFAULT_RECENT_TEXT_LIMIT);
  }

  recordIngress(params: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    chatType?: string;
    sessionKey?: string;
    content: unknown;
    shouldSkipMessage?: ShouldSkipMessage;
  }): boolean {
    if (typeof params.content !== "string") return false;
    const key = buildExactAutoCaptureSessionKey(params.sessionKey)
      ?? buildAutoCaptureConversationKeyFromIngress(
        params.channelId,
        params.conversationId,
        params.accountId,
        params.chatType,
      );
    if (!key) return false;
    const normalized = normalizeAutoCaptureText("user", params.content, params.shouldSkipMessage);
    if (!normalized) return false;

    const queue = [...(this.pendingIngressTexts.get(key) || []), normalized].slice(-this.recentTextLimit);
    this.pendingIngressTexts.set(key, queue);
    pruneOldest(this.pendingIngressTexts, this.maxEntries);
    return true;
  }

  consumeAgentEnd(params: {
    sessionKey: string;
    messages: unknown[];
    captureAssistant: boolean;
    shouldSkipMessage?: ShouldSkipMessage;
  }): AutoCaptureMessageSelection {
    const { eligibleTexts, skippedTextCount } = extractAutoCaptureEligibleTexts(params);
    const exactSessionKey = buildExactAutoCaptureSessionKey(params.sessionKey);
    const conversationKey = buildAutoCaptureConversationKeyFromSessionKey(params.sessionKey);
    const pendingKey = exactSessionKey && this.pendingIngressTexts.has(exactSessionKey)
      ? exactSessionKey
      : conversationKey;
    const pendingQueue = pendingKey
      ? [...(this.pendingIngressTexts.get(pendingKey) || [])]
      : [];
    const pendingSelection = consumePendingPrefix(pendingQueue, eligibleTexts);
    const pendingIngressTexts = pendingSelection.consumed;
    if (pendingKey) {
      if (pendingSelection.remaining.length > 0) {
        this.pendingIngressTexts.set(pendingKey, pendingSelection.remaining);
      } else {
        this.pendingIngressTexts.delete(pendingKey);
      }
    }

    const previousSeenCount = this.seenTextCount.get(params.sessionKey) ?? 0;
    let newTexts = eligibleTexts;
    if (pendingIngressTexts.length > 0) newTexts = pendingIngressTexts;
    else if (previousSeenCount > 0 && eligibleTexts.length >= previousSeenCount) {
      newTexts = eligibleTexts.slice(previousSeenCount);
    }

    this.seenTextCount.set(params.sessionKey, eligibleTexts.length);
    pruneOldest(this.seenTextCount, this.maxEntries);

    const priorRecentTexts = this.recentTexts.get(params.sessionKey) || [];
    let texts = newTexts;
    if (texts.length === 1 && EXPLICIT_REMEMBER_RE.test(texts[0].trim()) && priorRecentTexts.length > 0) {
      texts = [...priorRecentTexts.slice(-1), ...texts];
    }
    if (newTexts.length > 0) {
      this.recentTexts.set(
        params.sessionKey,
        [...priorRecentTexts, ...newTexts].slice(-this.recentTextLimit),
      );
      pruneOldest(this.recentTexts, this.maxEntries);
    }

    return {
      eligibleTexts,
      newTexts: [...newTexts],
      texts: [...texts],
      pendingIngressCount: pendingIngressTexts.length,
      skippedTextCount,
    };
  }

  /** Counts only, for bounded-state tests and diagnostics; never exposes text. */
  inspect(): { seenSessions: number; pendingConversations: number; recentSessions: number } {
    return {
      seenSessions: this.seenTextCount.size,
      pendingConversations: this.pendingIngressTexts.size,
      recentSessions: this.recentTexts.size,
    };
  }
}
