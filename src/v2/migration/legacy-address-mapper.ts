import type { MemoryAddressV2, MemoryVisibility } from "../domain/memory-address.js";

export interface LegacyMemoryRowAddressInput {
  id?: string;
  scope?: string;
  metadata?: string | Record<string, unknown>;
}

export interface LegacyAddressMapping {
  legacyId?: string;
  address: MemoryAddressV2;
  principalResolution: "runtime_metadata" | "legacy_unresolved";
  reviewRequired: boolean;
  verificationDebt: "none" | "legacy_identity" | "legacy_scope" | "legacy_identity_and_scope";
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(meta: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 512);
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function inferVisibility(scope: string, projectId?: string, conversationId?: string): MemoryVisibility {
  if (projectId || scope.startsWith("project:")) return "project";
  if (conversationId || scope.startsWith("custom:channel:")) return "conversation";
  if (scope === "global") return "global";
  return "private";
}

function scopeSuffix(scope: string, prefix: string): string | undefined {
  return scope.startsWith(prefix) ? scope.slice(prefix.length).trim() || undefined : undefined;
}

export function mapLegacyAddress(
  input: LegacyMemoryRowAddressInput,
  defaults: { tenantId: string; agentId: string; workspaceId?: string },
): LegacyAddressMapping {
  const meta = record(input.metadata);
  const scope = typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : "unknown";
  const platform = text(meta, ["platform", "provider", "surface"]);
  const accountId = text(meta, ["accountId", "account_id"]);
  const senderId = text(meta, ["principalId", "principal_id", "senderId", "sender_id", "userId", "user_id"]);
  const metadataAgentId = text(meta, ["agentId", "agent_id", "scope_owner_agent_id"]);
  const agentId = metadataAgentId ?? scopeSuffix(scope, "agent:") ?? defaults.agentId;
  const conversationId = text(meta, ["conversationId", "conversation_id", "chatId", "chat_id"])
    ?? scopeSuffix(scope, "custom:channel:");
  const threadId = text(meta, ["threadId", "thread_id", "messageThreadId", "message_thread_id"]);
  const projectId = text(meta, ["projectId", "project_id"]) ?? scopeSuffix(scope, "project:");
  const principalId = senderId
    ? [platform ?? "unknown-platform", accountId ?? "default", senderId].map(encodeURIComponent).join(":")
    : "legacy:unresolved";
  const visibility = inferVisibility(scope, projectId, conversationId);
  const scopeKnown = scope === "global"
    || scope.startsWith("agent:")
    || scope.startsWith("project:")
    || scope.startsWith("custom:channel:");
  const warnings: string[] = [];
  if (!senderId) warnings.push("legacy row has no sender principal; do not auto-confirm or auto-inject");
  if (!scopeKnown) warnings.push(`legacy scope '${scope}' needs operator mapping`);

  const verificationDebt = !senderId && !scopeKnown
    ? "legacy_identity_and_scope"
    : !senderId
      ? "legacy_identity"
      : !scopeKnown
        ? "legacy_scope"
        : "none";

  return {
    ...(input.id ? { legacyId: input.id } : {}),
    address: {
      schemaVersion: 2,
      tenantId: defaults.tenantId,
      principalId,
      agentId,
      ...(defaults.workspaceId ? { workspaceId: defaults.workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(platform ? { platform } : {}),
      ...(accountId ? { accountId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(threadId ? { threadId } : {}),
      visibility,
      retention: "durable",
    },
    principalResolution: senderId ? "runtime_metadata" : "legacy_unresolved",
    reviewRequired: !senderId || !scopeKnown,
    verificationDebt,
    warnings,
  };
}
