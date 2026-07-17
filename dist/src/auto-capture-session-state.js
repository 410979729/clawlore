import { normalizeAutoCaptureText } from "./auto-capture-cleanup.js";
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_RECENT_TEXT_LIMIT = 6;
const EXPLICIT_REMEMBER_RE = /^(?:请|請)?(?:记住|記住|记一下|記一下|别忘了|別忘了)[。.!?？!]*$/u;
function positiveInteger(value, fallback) {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
function pruneOldest(map, maximum) {
    while (map.size > maximum) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            return;
        map.delete(oldest);
    }
}
export function buildAutoCaptureConversationKeyFromIngress(channelId, conversationId) {
    const channel = typeof channelId === "string" ? channelId.trim() : "";
    const conversation = typeof conversationId === "string" ? conversationId.trim() : "";
    return channel && conversation ? `${channel}:${conversation}` : null;
}
/**
 * OpenClaw session keys use `agent:<agentId>:<channel>:<conversation...>`.
 * The channel/conversation suffix intentionally matches the ingress key while
 * preserving any additional colon-delimited group or thread components.
 */
export function buildAutoCaptureConversationKeyFromSessionKey(sessionKey) {
    const match = /^agent:[^:]+:(.+)$/.exec(sessionKey.trim());
    const suffix = match?.[1]?.trim();
    return suffix || null;
}
export function extractAutoCaptureEligibleTexts(params) {
    const eligibleTexts = [];
    let skippedTextCount = 0;
    const append = (role, text) => {
        const normalized = normalizeAutoCaptureText(role, text, params.shouldSkipMessage);
        if (normalized)
            eligibleTexts.push(normalized);
        else
            skippedTextCount += 1;
    };
    for (const message of params.messages) {
        if (!message || typeof message !== "object")
            continue;
        const record = message;
        const role = record.role;
        if (role !== "user" && !(params.captureAssistant && role === "assistant"))
            continue;
        if (typeof record.content === "string") {
            append(role, record.content);
            continue;
        }
        if (!Array.isArray(record.content))
            continue;
        for (const block of record.content) {
            if (!block || typeof block !== "object")
                continue;
            const textBlock = block;
            if (textBlock.type === "text" && typeof textBlock.text === "string")
                append(role, textBlock.text);
        }
    }
    return { eligibleTexts, skippedTextCount };
}
/**
 * Owns the bounded, cross-hook conversation cursor used by auto-capture.
 * It never resolves access, chooses scope, calls a model, or writes memory.
 */
export class AutoCaptureSessionState {
    maxEntries;
    recentTextLimit;
    seenTextCount = new Map();
    pendingIngressTexts = new Map();
    recentTexts = new Map();
    constructor(options = {}) {
        this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
        this.recentTextLimit = positiveInteger(options.recentTextLimit, DEFAULT_RECENT_TEXT_LIMIT);
    }
    recordIngress(params) {
        if (typeof params.content !== "string")
            return false;
        const key = buildAutoCaptureConversationKeyFromIngress(params.channelId, params.conversationId);
        if (!key)
            return false;
        const normalized = normalizeAutoCaptureText("user", params.content, params.shouldSkipMessage);
        if (!normalized)
            return false;
        const queue = [...(this.pendingIngressTexts.get(key) || []), normalized].slice(-this.recentTextLimit);
        this.pendingIngressTexts.set(key, queue);
        pruneOldest(this.pendingIngressTexts, this.maxEntries);
        return true;
    }
    consumeAgentEnd(params) {
        const { eligibleTexts, skippedTextCount } = extractAutoCaptureEligibleTexts(params);
        const conversationKey = buildAutoCaptureConversationKeyFromSessionKey(params.sessionKey);
        const pendingIngressTexts = conversationKey
            ? [...(this.pendingIngressTexts.get(conversationKey) || [])]
            : [];
        if (conversationKey)
            this.pendingIngressTexts.delete(conversationKey);
        const previousSeenCount = this.seenTextCount.get(params.sessionKey) ?? 0;
        let newTexts = eligibleTexts;
        if (pendingIngressTexts.length > 0)
            newTexts = pendingIngressTexts;
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
            this.recentTexts.set(params.sessionKey, [...priorRecentTexts, ...newTexts].slice(-this.recentTextLimit));
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
    inspect() {
        return {
            seenSessions: this.seenTextCount.size,
            pendingConversations: this.pendingIngressTexts.size,
            recentSessions: this.recentTexts.size,
        };
    }
}
