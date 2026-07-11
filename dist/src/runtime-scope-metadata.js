const MAX_FIELD_CHARS = 512;
const MAX_SCOPE_FILTER_ITEMS = 64;
function normalizeString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.length > MAX_FIELD_CHARS
        ? trimmed.slice(0, MAX_FIELD_CHARS)
        : trimmed;
}
function objectRecord(value) {
    return value && typeof value === "object"
        ? value
        : undefined;
}
function pickString(contexts, keys) {
    for (const context of contexts) {
        const record = objectRecord(context);
        if (!record)
            continue;
        for (const key of keys) {
            const value = normalizeString(record[key]);
            if (value)
                return value;
        }
    }
    return undefined;
}
function normalizeScopeFilter(scopeFilter) {
    if (scopeFilter === undefined)
        return undefined;
    return scopeFilter
        .map((scope) => normalizeString(scope))
        .filter((scope) => Boolean(scope))
        .slice(0, MAX_SCOPE_FILTER_ITEMS);
}
export function buildRuntimeScopeMetadata(input) {
    const contexts = [input.runtimeContext, input.event, input.staticContext];
    const agentId = normalizeString(input.agentId) ?? pickString(contexts, ["agentId", "agent_id"]);
    const sessionKey = normalizeString(input.sourceSession)
        ?? pickString(contexts, ["sessionKey", "session_key"]);
    const sessionId = pickString(contexts, ["sessionId", "session_id"]);
    const channelId = pickString(contexts, ["channelId", "channel_id", "channel"]);
    const accountId = pickString(contexts, ["accountId", "account_id"]);
    const conversationId = pickString(contexts, [
        "conversationId",
        "conversation_id",
        "chatId",
        "chat_id",
        "to",
    ]);
    const threadId = pickString(contexts, [
        "threadId",
        "thread_id",
        "messageThreadId",
        "message_thread_id",
        "topicId",
        "topic_id",
    ]);
    const platform = pickString(contexts, ["platform", "provider", "surface"]);
    const workspaceDir = normalizeString(input.workspaceDir)
        ?? pickString(contexts, ["workspaceDir", "workspace_dir"]);
    const scopeId = normalizeString(input.scope);
    const normalizedScopeFilter = normalizeScopeFilter(input.scopeFilter);
    const metadata = {
        runtime_contract: "openclaw-scope-v1",
    };
    if (agentId) {
        metadata.agentId = agentId;
        metadata.agent_id = agentId;
        metadata.scope_owner_agent_id = agentId;
    }
    if (sessionKey) {
        metadata.sessionKey = sessionKey;
        metadata.session_key = sessionKey;
        metadata.source_session = sessionKey;
    }
    if (sessionId) {
        metadata.sessionId = sessionId;
        metadata.session_id = sessionId;
    }
    if (channelId)
        metadata.channel_id = channelId;
    if (accountId)
        metadata.account_id = accountId;
    if (conversationId)
        metadata.conversation_id = conversationId;
    if (threadId)
        metadata.thread_id = threadId;
    if (platform)
        metadata.platform = platform;
    if (workspaceDir)
        metadata.workspace_dir = workspaceDir;
    if (scopeId)
        metadata.scope_id = scopeId;
    if (normalizedScopeFilter === undefined) {
        metadata.scope_filter_mode = "bypass";
    }
    else {
        metadata.scope_filter = normalizedScopeFilter;
        metadata.scope_filter_mode = normalizedScopeFilter.length > 0 ? "restricted" : "deny_all";
    }
    return metadata;
}
