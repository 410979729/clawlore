import type {
  MemoryAddressV2,
  MemoryRetention,
  MemoryVisibility,
} from "../v2/domain/memory-address.js";
import { validateMemoryAddress } from "../v2/domain/memory-address.js";

export interface IdentityResolverInput {
  tenantId?: string;
  agentId?: string;
  workspaceId?: string;
  workspaceDir?: string;
  projectId?: string;
  customerId?: string;
  taskId?: string;
  configuredPrincipalId?: string;
  linkedPrincipalId?: string;
  requestedVisibility?: MemoryVisibility;
  requestedRetention?: MemoryRetention;
  runtimeContext?: unknown;
  event?: unknown;
  staticContext?: unknown;
}

export interface IdentityEvidence {
  field: keyof MemoryAddressV2 | "chatType";
  source: "input" | "runtime" | "event" | "static" | "configured_fallback" | "explicit_link";
  value: string;
}

export interface IdentityResolution {
  status: "resolved" | "unresolved";
  address?: MemoryAddressV2;
  durableWriteAllowed: boolean;
  evidence: IdentityEvidence[];
  warnings: string[];
  missing: Array<"agentId" | "principalId">;
}

type SourceName = IdentityEvidence["source"];

const MAX_FIELD_CHARS = 512;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_FIELD_CHARS);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function recordsFor(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (!root) return [];
  const nested = ["sender", "from", "conversation", "chat", "channel", "metadata"]
    .map((key) => record(root[key]))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  return [root, ...nested];
}

function pick(
  sources: Array<{ name: SourceName; value: unknown }>,
  keys: string[],
): { value?: string; source?: SourceName } {
  for (const source of sources) {
    for (const candidate of recordsFor(source.value)) {
      for (const key of keys) {
        const value = clean(candidate[key]);
        if (value) return { value, source: source.name };
      }
    }
  }
  return {};
}

function normalizeChatType(value: string | undefined): "direct" | "group" | "channel" | "unknown" {
  const normalized = value?.toLowerCase();
  if (["direct", "private", "dm", "im"].includes(normalized ?? "")) return "direct";
  if (["group", "supergroup"].includes(normalized ?? "")) return "group";
  if (["channel", "guild", "server"].includes(normalized ?? "")) return "channel";
  return "unknown";
}

function defaultVisibility(
  chatType: ReturnType<typeof normalizeChatType>,
  projectId: string | undefined,
): MemoryVisibility {
  if (projectId) return "project";
  if (chatType === "group" || chatType === "channel") return "conversation";
  return "private";
}

function namespacedPrincipal(platform: string | undefined, accountId: string | undefined, senderId: string): string {
  return [platform ?? "unknown-platform", accountId ?? "default", senderId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function resolveMemoryIdentity(input: IdentityResolverInput): IdentityResolution {
  const sources: Array<{ name: SourceName; value: unknown }> = [
    { name: "runtime", value: input.runtimeContext },
    { name: "event", value: input.event },
    { name: "static", value: input.staticContext },
  ];
  const evidence: IdentityEvidence[] = [];
  const warnings: string[] = [];

  const runtimeAgent = pick(sources, ["agentId", "agent_id"]);
  const agentId = clean(input.agentId) ?? runtimeAgent.value;
  if (agentId) evidence.push({ field: "agentId", source: clean(input.agentId) ? "input" : runtimeAgent.source!, value: agentId });

  const platformResult = pick(sources, ["platform", "provider", "surface"]);
  const platform = platformResult.value;
  if (platform) evidence.push({ field: "platform", source: platformResult.source!, value: platform });

  const accountResult = pick(sources, ["accountId", "account_id"]);
  const accountId = accountResult.value;
  if (accountId) evidence.push({ field: "accountId", source: accountResult.source!, value: accountId });

  const senderResult = pick(sources, ["senderId", "sender_id", "userId", "user_id", "fromId", "from_id"]);
  const linkedPrincipalId = clean(input.linkedPrincipalId);
  const configuredPrincipalId = clean(input.configuredPrincipalId);
  let principalId: string | undefined;
  if (linkedPrincipalId) {
    principalId = linkedPrincipalId;
    evidence.push({ field: "principalId", source: "explicit_link", value: principalId });
  } else if (senderResult.value) {
    principalId = namespacedPrincipal(platform, accountId, senderResult.value);
    evidence.push({ field: "principalId", source: senderResult.source!, value: principalId });
  } else if (configuredPrincipalId) {
    principalId = configuredPrincipalId;
    evidence.push({ field: "principalId", source: "configured_fallback", value: principalId });
    warnings.push("principal resolved from explicit configured fallback because sender identity was unavailable");
  }

  const conversationResult = pick(sources, ["conversationId", "conversation_id", "chatId", "chat_id", "to"]);
  const conversationId = conversationResult.value;
  if (conversationId) evidence.push({ field: "conversationId", source: conversationResult.source!, value: conversationId });

  const threadResult = pick(sources, ["threadId", "thread_id", "messageThreadId", "message_thread_id", "topicId", "topic_id"]);
  const threadId = threadResult.value;
  if (threadId) evidence.push({ field: "threadId", source: threadResult.source!, value: threadId });

  const chatTypeResult = pick(sources, ["chatType", "chat_type", "conversationType", "conversation_type"]);
  const chatType = normalizeChatType(chatTypeResult.value);
  if (chatTypeResult.value) evidence.push({ field: "chatType", source: chatTypeResult.source!, value: chatType });

  const tenantId = clean(input.tenantId) ?? "local";
  const workspaceId = clean(input.workspaceId) ?? clean(input.workspaceDir);
  const projectId = clean(input.projectId);
  const customerId = clean(input.customerId);
  const taskId = clean(input.taskId);
  const visibility = input.requestedVisibility ?? defaultVisibility(chatType, projectId);
  const retention = input.requestedRetention ?? "working";
  const missing: IdentityResolution["missing"] = [];
  if (!agentId) missing.push("agentId");
  if (!principalId) missing.push("principalId");

  if (missing.length > 0) {
    if (!principalId) warnings.push("sender principal is unresolved; durable writes must fail closed");
    if (!agentId) warnings.push("agent identity is unresolved; recall and durable writes must fail closed");
    return { status: "unresolved", durableWriteAllowed: false, evidence, warnings, missing };
  }

  const address: MemoryAddressV2 = {
    schemaVersion: 2,
    tenantId,
    principalId: principalId!,
    agentId: agentId!,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(platform ? { platform } : {}),
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(taskId ? { taskId } : {}),
    visibility,
    retention,
  };
  const validation = validateMemoryAddress(address);
  if (!validation.valid) {
    warnings.push(...validation.errors.map((error) => error.message));
    return { status: "unresolved", durableWriteAllowed: false, evidence, warnings, missing: [] };
  }

  return {
    status: "resolved",
    address,
    durableWriteAllowed: true,
    evidence,
    warnings,
    missing: [],
  };
}
