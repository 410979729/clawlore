export interface RuntimeScopeMetadataInput {
  agentId?: string;
  staticContext?: unknown;
  runtimeContext?: unknown;
  event?: unknown;
  scope?: string;
  scopeFilter?: string[];
  workspaceDir?: string;
  sourceSession?: string;
}

export type RuntimeScopeMetadata = Record<string, unknown>;

const MAX_FIELD_CHARS = 512;
const MAX_SCOPE_FILTER_ITEMS = 64;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_FIELD_CHARS
    ? trimmed.slice(0, MAX_FIELD_CHARS)
    : trimmed;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function pickString(contexts: unknown[], keys: string[]): string | undefined {
  for (const context of contexts) {
    const record = objectRecord(context);
    if (!record) continue;
    for (const key of keys) {
      const value = normalizeString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function normalizeScopeFilter(scopeFilter: string[] | undefined): string[] | undefined {
  if (scopeFilter === undefined) return undefined;
  return scopeFilter
    .map((scope) => normalizeString(scope))
    .filter((scope): scope is string => Boolean(scope))
    .slice(0, MAX_SCOPE_FILTER_ITEMS);
}

export function buildRuntimeScopeMetadata(
  input: RuntimeScopeMetadataInput,
): RuntimeScopeMetadata {
  const contexts = [input.runtimeContext, input.event, input.staticContext];
  const agentId = normalizeString(input.agentId) ?? pickString(contexts, ["agentId", "agent_id"]);
  const sessionKey =
    normalizeString(input.sourceSession)
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
  const workspaceDir =
    normalizeString(input.workspaceDir)
    ?? pickString(contexts, ["workspaceDir", "workspace_dir"]);
  const scopeId = normalizeString(input.scope);
  const normalizedScopeFilter = normalizeScopeFilter(input.scopeFilter);

  const metadata: RuntimeScopeMetadata = {
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
  if (channelId) metadata.channel_id = channelId;
  if (accountId) metadata.account_id = accountId;
  if (conversationId) metadata.conversation_id = conversationId;
  if (threadId) metadata.thread_id = threadId;
  if (platform) metadata.platform = platform;
  // The resolved path influences runtime routing but is not durable memory
  // content. Persist only the fact that a workspace boundary was resolved.
  if (workspaceDir) metadata.workspace_bound = true;
  if (scopeId) metadata.scope_id = scopeId;

  if (normalizedScopeFilter === undefined) {
    metadata.scope_filter_mode = "bypass";
  } else {
    metadata.scope_filter = normalizedScopeFilter;
    metadata.scope_filter_mode = normalizedScopeFilter.length > 0 ? "restricted" : "deny_all";
  }

  return metadata;
}
