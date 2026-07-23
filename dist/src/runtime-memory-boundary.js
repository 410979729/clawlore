import { createHash } from "node:crypto";
import { isSystemBypassId, resolveScopeFilter, } from "./scopes.js";
function record(value) {
    return value && typeof value === "object" ? value : undefined;
}
function text(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return undefined;
    const normalized = String(value).trim();
    return normalized || undefined;
}
/**
 * Accepts an exact runtime principal key (`platform:account:principal`).
 * Wildcards, whitespace, missing segments, and control characters fail closed.
 */
export function isCanonicalPrincipalKey(value) {
    const principal = text(value);
    if (!principal || principal !== value || principal.length > 512 || principal.includes("*") || /[\s\u0000-\u001f\u007f]/.test(principal)) {
        return false;
    }
    const firstSeparator = principal.indexOf(":");
    const secondSeparator = principal.indexOf(":", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1 || secondSeparator >= principal.length - 1) {
        return false;
    }
    const platform = principal.slice(0, firstSeparator);
    const accountId = principal.slice(firstSeparator + 1, secondSeparator);
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(platform)
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(accountId);
}
function pick(contexts, keys) {
    for (const context of contexts) {
        const candidate = record(context);
        if (!candidate)
            continue;
        for (const key of keys) {
            const value = text(candidate[key]);
            if (value)
                return value;
        }
    }
    return undefined;
}
function shortHash(value, length = 32) {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}
export function runtimePrincipalIdentity(principalKey) {
    if (!isCanonicalPrincipalKey(principalKey)) {
        throw new Error("principalKey must be an exact canonical platform:account:principal key");
    }
    return {
        principalHash: shortHash(principalKey, 16),
        scope: `user:${shortHash(principalKey)}`,
    };
}
function parseSessionBoundary(sessionKey) {
    if (!sessionKey)
        return {};
    const parts = sessionKey.split(":").map((part) => part.trim());
    if (parts[0] !== "agent" || parts.length < 3)
        return {};
    const platform = parts[2] || undefined;
    const kindIndex = parts.findIndex((part, index) => index >= 3 && ["direct", "group", "channel"].includes(part));
    if (kindIndex < 0)
        return { platform };
    const chatType = parts[kindIndex];
    const accountId = kindIndex > 3 ? parts.slice(3, kindIndex).join(":") || undefined : undefined;
    const peerId = parts.slice(kindIndex + 1).join(":") || undefined;
    return { platform, accountId, chatType, peerId };
}
function explicitChatType(contexts) {
    for (const context of contexts) {
        const candidate = record(context);
        if (!candidate)
            continue;
        if (candidate.isGroup === true)
            return "group";
        if (candidate.isGroup === false)
            return "direct";
        const raw = text(candidate.chatType ?? candidate.chat_type ?? candidate.peerKind ?? candidate.peer_kind)?.toLowerCase();
        if (raw === "direct" || raw === "dm" || raw === "private")
            return "direct";
        if (raw === "group")
            return "group";
        if (raw === "channel")
            return "channel";
    }
    return undefined;
}
export function normalizePrincipalIsolationConfig(value) {
    const principals = Array.isArray(value?.legacyAgentScopePrincipals)
        ? value.legacyAgentScopePrincipals
            .filter(isCanonicalPrincipalKey)
        : [];
    return {
        enabled: value?.enabled !== false,
        groupMemory: value?.groupMemory === "conversation" ? "conversation" : "deny",
        legacyAgentScopePrincipals: [...new Set(principals)].sort(),
        allowGlobalRead: value?.allowGlobalRead === true,
    };
}
export function resolveRuntimeMemoryBoundary(input) {
    const contexts = [input.runtimeContext, input.event, input.staticContext];
    const sessionKey = pick(contexts, ["sessionKey", "session_key"]);
    const session = parseSessionBoundary(sessionKey);
    const chatType = explicitChatType(contexts) ?? session.chatType;
    // OpenClaw agent hooks expose the provider separately from channelId.
    // For Telegram DMs, channelId is the numeric peer id; treating it as the
    // platform splits automatic capture/recall from CLI and tool writes.
    const platform = pick(contexts, [
        "platform",
        "provider",
        "surface",
        "channel",
        "messageProvider",
        "message_provider",
    ])
        ?? session.platform
        // Legacy plugin fixtures used channelId as a provider name. Keep that
        // fallback only after explicit provider fields and the session boundary.
        ?? pick(contexts, ["channelId", "channel_id"]);
    const accountId = pick(contexts, ["accountId", "account_id"]) ?? session.accountId ?? "default";
    const senderId = pick(contexts, ["senderId", "sender_id", "userId", "user_id", "from"]);
    const conversationId = pick(contexts, [
        "conversationId",
        "conversation_id",
        "chatId",
        "chat_id",
        "to",
    ]);
    if (chatType === "direct") {
        const principalId = senderId ?? conversationId ?? session.peerId;
        if (!principalId || !platform)
            return { kind: "unknown", platform, accountId };
        const principalKey = `${platform}:${accountId}:${principalId}`;
        const principalIdentity = runtimePrincipalIdentity(principalKey);
        return {
            kind: "private",
            platform,
            accountId,
            principalKey,
            ...principalIdentity,
        };
    }
    if (chatType === "group" || chatType === "channel") {
        const peerId = conversationId ?? session.peerId;
        if (!peerId || !platform)
            return { kind: "unknown", platform, accountId };
        const conversationKey = `${platform}:${accountId}:${chatType}:${peerId}`;
        const conversationHash = shortHash(conversationKey, 16);
        return {
            kind: "conversation",
            platform,
            accountId,
            conversationKey,
            conversationHash,
            scope: `custom:channel:${shortHash(conversationKey)}`,
        };
    }
    const hasExternalSignals = Boolean(platform || senderId || conversationId || session.chatType);
    return { kind: hasExternalSignals ? "unknown" : "internal", platform, accountId };
}
export function resolveRuntimeMemoryAccess(input) {
    const config = normalizePrincipalIsolationConfig(input.config);
    const boundary = resolveRuntimeMemoryBoundary(input);
    if (!config.enabled || boundary.kind === "internal" || isSystemBypassId(input.agentId)) {
        const scopeFilter = resolveScopeFilter(input.scopeManager, input.agentId);
        return {
            boundary,
            defaultScope: isSystemBypassId(input.agentId)
                ? undefined
                : input.scopeManager.getDefaultScope(input.agentId),
            scopeFilter,
            denied: false,
            isAccessible: (scope) => input.scopeManager.isAccessible(scope, input.agentId),
        };
    }
    if (boundary.kind === "unknown" || !boundary.scope) {
        return {
            boundary,
            scopeFilter: [],
            denied: true,
            denyReason: "runtime_boundary_unresolved",
            isAccessible: () => false,
        };
    }
    if (boundary.kind === "conversation" && config.groupMemory !== "conversation") {
        return {
            boundary,
            scopeFilter: [],
            denied: true,
            denyReason: "group_memory_denied",
            isAccessible: () => false,
        };
    }
    const scopes = [boundary.scope];
    if (boundary.kind === "private"
        && boundary.principalKey
        && config.legacyAgentScopePrincipals.includes(boundary.principalKey)) {
        scopes.push(`agent:${input.agentId}`);
    }
    if (config.allowGlobalRead)
        scopes.push("global");
    const scopeFilter = [...new Set(scopes)];
    return {
        boundary,
        defaultScope: boundary.scope,
        scopeFilter,
        denied: false,
        isAccessible: (scope) => scopeFilter.includes(scope),
    };
}
export function runtimeBoundaryMetadata(boundary) {
    return {
        memory_boundary: boundary.kind,
        ...(boundary.principalHash ? { principal_hash: boundary.principalHash } : {}),
        ...(boundary.conversationHash ? { conversation_hash: boundary.conversationHash } : {}),
    };
}
