import { cleanUserRecallQuery, selectAutoRecallQuery } from "./auto-recall-query.js";
function firstString(records, names) {
    for (const record of records) {
        if (!record || typeof record !== "object")
            continue;
        for (const name of names) {
            const value = record[name];
            if (typeof value === "string" && value.trim())
                return value.trim();
        }
    }
    return undefined;
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => Boolean(value)))];
}
function exactTurnAliases(event, ctx) {
    const records = [ctx, event];
    const channelId = firstString(records, ["channelId", "channel", "provider"]);
    const accountId = firstString(records, ["accountId", "account_id"]);
    const runId = firstString(records, ["runId", "run_id", "turnId", "turn_id"]);
    const messageId = firstString(records, ["messageId", "message_id", "inboundMessageId", "inbound_message_id"]);
    return uniqueStrings([
        runId ? `run-id:${runId}` : undefined,
        messageId ? `message-id:${channelId ?? "unknown"}:${accountId ?? "default"}:${messageId}` : undefined,
    ]);
}
function sessionAliases(event, ctx) {
    const records = [ctx, event];
    const sessionKey = firstString(records, ["sessionKey", "session_key"]);
    const sessionId = firstString(records, ["sessionId", "session_id"]);
    return uniqueStrings([
        sessionKey ? `session-key:${sessionKey}` : undefined,
        sessionId ? `session-id:${sessionId}` : undefined,
    ]);
}
function conversationBoundary(event, ctx) {
    const records = [ctx, event];
    const channelId = firstString(records, ["channelId", "channel", "provider"]);
    const accountId = firstString(records, ["accountId", "account_id"]);
    const conversationId = firstString(records, ["conversationId", "conversation_id", "chatId", "chat_id"]);
    const senderId = firstString(records, ["senderId", "sender_id", "from"]);
    if (!channelId || !accountId || !conversationId || !senderId)
        return undefined;
    return `boundary:${channelId}:${accountId}:${conversationId}:${senderId}`;
}
function correlationHint(stableBoundary) {
    const normalized = typeof stableBoundary === "string" ? stableBoundary.trim() : "";
    return normalized ? `correlation-hint:${normalized}` : undefined;
}
/**
 * Resolves the narrowest real session/conversation boundary used for recall
 * history and cleanup. A principal scope is only a last-resort correlation
 * hint; it is never preferred over a concrete session and is never a turn id.
 */
export function resolveAutoRecallSessionBoundary(event, ctx, stableBoundary) {
    const sessions = sessionAliases(event, ctx);
    if (sessions.length > 0)
        return sessions[0];
    const conversation = conversationBoundary(event, ctx);
    if (conversation)
        return conversation;
    const hint = correlationHint(stableBoundary);
    return hint ? hint.replace(/^correlation-hint:/, "memory-boundary:") : undefined;
}
function pendingQueueKeys(event, ctx, stableBoundary) {
    return uniqueStrings([
        ...sessionAliases(event, ctx).map((alias) => `pending:${alias}`),
        conversationBoundary(event, ctx) ? `pending:${conversationBoundary(event, ctx)}` : undefined,
        correlationHint(stableBoundary) ? `pending:${correlationHint(stableBoundary)}` : undefined,
    ]);
}
/**
 * Correlates ingress text with the later prompt hook without ever treating a
 * long-lived principal scope as a turn alias. Exact run/message ids win. When
 * hook ids differ, a bounded FIFO bridges the real session/conversation. Once
 * selected, an entry is consumed from every pending queue and bound to the
 * prompt's exact/session aliases for idempotent retries.
 */
export class AutoRecallSessionCache {
    maxEntries;
    ttlMs;
    now;
    entries = new Map();
    exactAliasToEntry = new Map();
    boundSessionToEntry = new Map();
    pendingByQueue = new Map();
    nextId = 1;
    constructor(maxEntries = 2_048, ttlMs = 30 * 60 * 1_000, now = Date.now) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.now = now;
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error("AutoRecallSessionCache maxEntries must be a positive integer");
        }
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            throw new Error("AutoRecallSessionCache ttlMs must be positive");
        }
    }
    prune() {
        const now = this.now();
        for (const [id, entry] of this.entries) {
            if (now - entry.updatedAt >= this.ttlMs)
                this.deleteEntry(id);
        }
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (typeof oldest !== "number")
                break;
            this.deleteEntry(oldest);
        }
    }
    removeFromPendingQueues(entry) {
        for (const queueKey of entry.pendingQueues) {
            const queue = this.pendingByQueue.get(queueKey);
            if (!queue)
                continue;
            const next = queue.filter((id) => id !== entry.id && this.entries.has(id));
            if (next.length > 0)
                this.pendingByQueue.set(queueKey, next);
            else
                this.pendingByQueue.delete(queueKey);
        }
        entry.pendingQueues.clear();
    }
    removeFromPendingQueue(entry, queueKey) {
        const queue = this.pendingByQueue.get(queueKey);
        if (queue) {
            const next = queue.filter((id) => id !== entry.id && this.entries.has(id));
            if (next.length > 0)
                this.pendingByQueue.set(queueKey, next);
            else
                this.pendingByQueue.delete(queueKey);
        }
        entry.pendingQueues.delete(queueKey);
    }
    detachAmbiguousCorrelation(queueKey, entryIds) {
        for (const id of entryIds) {
            const entry = this.entries.get(id);
            if (!entry)
                continue;
            for (const pendingKey of [...entry.pendingQueues]) {
                const isDifferentExactSessionQueue = pendingKey !== queueKey
                    && /^pending:session-(?:key|id):/u.test(pendingKey);
                if (!isDifferentExactSessionQueue)
                    this.removeFromPendingQueue(entry, pendingKey);
            }
            if (entry.exactAliases.size === 0 && entry.pendingQueues.size === 0) {
                this.deleteEntry(entry.id);
            }
        }
    }
    deleteEntry(id) {
        const entry = this.entries.get(id);
        if (!entry)
            return;
        this.entries.delete(id);
        this.removeFromPendingQueues(entry);
        for (const alias of entry.exactAliases) {
            if (this.exactAliasToEntry.get(alias) === id)
                this.exactAliasToEntry.delete(alias);
        }
        for (const alias of entry.sessionAliases) {
            if (this.boundSessionToEntry.get(alias) === id)
                this.boundSessionToEntry.delete(alias);
        }
    }
    linkExact(entry, aliases) {
        for (const alias of aliases) {
            entry.exactAliases.add(alias);
            this.exactAliasToEntry.set(alias, entry.id);
        }
    }
    linkSessions(entry, aliases, bind) {
        for (const alias of aliases) {
            entry.sessionAliases.add(alias);
            if (bind)
                this.boundSessionToEntry.set(alias, entry.id);
        }
    }
    enqueue(entry, queueKeys) {
        for (const queueKey of queueKeys) {
            const queue = this.pendingByQueue.get(queueKey) ?? [];
            if (!queue.includes(entry.id))
                queue.push(entry.id);
            this.pendingByQueue.set(queueKey, queue);
            entry.pendingQueues.add(queueKey);
        }
    }
    firstPending(queueKeys) {
        for (const queueKey of queueKeys) {
            const queue = (this.pendingByQueue.get(queueKey) ?? [])
                .filter((id) => {
                const entry = this.entries.get(id);
                return Boolean(entry && !entry.claimed);
            });
            if (queue.length > 0) {
                this.pendingByQueue.set(queueKey, queue);
                // More than one unbound turn at the same conversation/principal hint
                // is ambiguous. Failing closed is safer than attaching the oldest
                // message to a later out-of-order prompt.
                if (queue.length > 1) {
                    this.detachAmbiguousCorrelation(queueKey, queue);
                    return { status: "ambiguous" };
                }
                const entry = this.entries.get(queue[0]);
                return entry ? { status: "matched", entry } : { status: "none" };
            }
            this.pendingByQueue.delete(queueKey);
        }
        return { status: "none" };
    }
    remember(event, ctx, stableBoundary) {
        this.prune();
        const exactAliases = exactTurnAliases(event, ctx);
        const sessions = sessionAliases(event, ctx);
        const queues = pendingQueueKeys(event, ctx, stableBoundary);
        if (exactAliases.length === 0 && sessions.length === 0 && queues.length === 0)
            return undefined;
        const raw = typeof event?.content === "string" ? event.content : "";
        const text = cleanUserRecallQuery(raw);
        if (!text)
            return exactAliases[0] ?? sessions[0] ?? queues[0];
        const existingId = exactAliases
            .map((alias) => this.exactAliasToEntry.get(alias))
            .find((id) => typeof id === "number");
        let entry = existingId === undefined ? undefined : this.entries.get(existingId);
        if (!entry) {
            const id = this.nextId++;
            entry = {
                id,
                turnKey: exactAliases[0] ?? `cache-entry:${id}`,
                query: text,
                exactAliases: new Set(),
                sessionAliases: new Set(),
                pendingQueues: new Set(),
                claimed: false,
                updatedAt: this.now(),
            };
            this.entries.set(id, entry);
        }
        else {
            entry.query = text;
            entry.updatedAt = this.now();
        }
        this.linkExact(entry, exactAliases);
        this.linkSessions(entry, sessions, false);
        this.enqueue(entry, queues);
        this.prune();
        return entry.turnKey;
    }
    select(event, ctx, maxChars, stableBoundary) {
        this.prune();
        const exactAliases = exactTurnAliases(event, ctx);
        const sessions = sessionAliases(event, ctx);
        let entry = exactAliases
            .map((alias) => this.exactAliasToEntry.get(alias))
            .map((id) => id === undefined ? undefined : this.entries.get(id))
            .find((candidate) => Boolean(candidate));
        const pending = entry
            ? { status: "none" }
            : this.firstPending(pendingQueueKeys(event, ctx, stableBoundary));
        if (!entry && pending.status === "ambiguous") {
            return {
                ...selectAutoRecallQuery({ maxChars }),
                duplicate: false,
                correlationIssue: "ambiguous_correlation",
            };
        }
        if (!entry && pending.status === "matched")
            entry = pending.entry;
        if (!entry) {
            entry = sessions
                .map((alias) => this.boundSessionToEntry.get(alias))
                .map((id) => id === undefined ? undefined : this.entries.get(id))
                .find((candidate) => Boolean(candidate));
        }
        if (!entry)
            return { ...selectAutoRecallQuery({ maxChars }), duplicate: false };
        entry.updatedAt = this.now();
        this.linkExact(entry, exactAliases);
        this.linkSessions(entry, sessions, true);
        this.removeFromPendingQueues(entry);
        const duplicate = entry.claimed;
        entry.claimed = true;
        return {
            ...selectAutoRecallQuery({ cachedUserMessage: entry.query, maxChars }),
            duplicate,
            turnKey: entry.turnKey,
        };
    }
    clear(event, ctx, _stableBoundary) {
        this.prune();
        const exactAliases = new Set(exactTurnAliases(event, ctx));
        const sessions = new Set(sessionAliases(event, ctx));
        if (exactAliases.size === 0 && sessions.size === 0)
            return undefined;
        for (const [id, entry] of this.entries) {
            const exactMatch = [...entry.exactAliases].some((alias) => exactAliases.has(alias));
            const sessionMatch = [...entry.sessionAliases].some((alias) => sessions.has(alias));
            // A steer-capable host may accept the next user message before the
            // current run emits session_end. When the ending run supplies an exact
            // alias, clear only that turn. Falling through to the broad session
            // alias would also erase the newer, still-unclaimed ingress entry.
            if (exactAliases.size > 0) {
                if (exactMatch)
                    this.deleteEntry(id);
                continue;
            }
            // Older hosts do not always expose a run/message id on session_end. In
            // that case only claimed entries are known to belong to the ending run;
            // unclaimed entries remain pending until selected or TTL eviction.
            if (sessionMatch && entry.claimed)
                this.deleteEntry(id);
        }
        return [...sessions][0] ?? [...exactAliases][0];
    }
    size() {
        this.prune();
        return this.entries.size;
    }
}
