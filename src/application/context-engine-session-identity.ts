import type { MemoryAddressV2 } from "../v2/domain/memory-address.js";

function sessionIdentity(sessionKey: string | undefined): {
  agentId?: string;
  platform?: string;
  accountId?: string;
  kind?: "direct" | "group" | "channel";
  peerId?: string;
} {
  if (!sessionKey) return {};
  const parts = sessionKey.split(":").map((part) => part.trim());
  if (parts[0] !== "agent" || parts.length < 3) return {};
  const kindIndex = parts.findIndex(
    (part, index) => index >= 3 && ["direct", "group", "channel"].includes(part),
  );
  if (kindIndex < 0) return { agentId: parts[1], platform: parts[2] };
  return {
    agentId: parts[1] || undefined,
    platform: parts[2] || undefined,
    accountId: kindIndex > 3 ? parts.slice(3, kindIndex).join(":") || "default" : "default",
    kind: parts[kindIndex] as "direct" | "group" | "channel",
    peerId: parts.slice(kindIndex + 1).join(":") || undefined,
  };
}

/**
 * Resolves only the identity that the ContextEngine contract proves. The
 * current host passes a session key but no trusted per-message sender metadata,
 * so group/channel sessions cannot safely become an automatic-recall actor.
 */
export function resolveContextEngineActorAddressV1(input: {
  sessionKey?: string;
  tenantId: string;
  configuredAgentId: string;
  workspaceId?: string;
}): MemoryAddressV2 | undefined {
  const identity = sessionIdentity(input.sessionKey);
  if (
    identity.kind !== "direct"
    || !identity.platform
    || !identity.peerId
    || (identity.agentId && identity.agentId !== input.configuredAgentId)
  ) {
    return undefined;
  }
  const accountId = identity.accountId ?? "default";
  return {
    schemaVersion: 2,
    tenantId: input.tenantId,
    principalId: `${identity.platform}:${accountId}:${identity.peerId}`,
    agentId: input.configuredAgentId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    platform: identity.platform,
    accountId,
    visibility: "private",
    retention: "working",
  };
}
