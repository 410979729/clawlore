import {
  isCanonicalPrincipalKey,
  resolveRuntimeMemoryBoundary,
  runtimePrincipalIdentity,
} from "./runtime-memory-boundary.js";

export const CLAWLORE_PRINCIPAL_SCOPE_CONTRACT = "openclaw-scope-v1" as const;

export interface PrincipalWriteTarget {
  contract: typeof CLAWLORE_PRINCIPAL_SCOPE_CONTRACT;
  kind: "private" | "conversation";
  scope: string;
  principalHash?: string;
  conversationHash?: string;
}

function exactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized === value ? normalized : undefined;
}

/**
 * Resolve the only durable scope that an out-of-band writer may target.
 *
 * Callers submit identity, never a precomputed/default scope. This keeps CLI,
 * cron, manual import, and runtime writes on the same versioned boundary and
 * makes missing or ambiguous identity fail closed.
 */
export function resolvePrincipalWriteTarget(input: {
  principalKey?: unknown;
  sessionKey?: unknown;
  allowConversation?: boolean;
}): PrincipalWriteTarget {
  const principalKey = exactText(input.principalKey);
  const sessionKey = exactText(input.sessionKey);
  if (Boolean(principalKey) === Boolean(sessionKey)) {
    throw new Error("CLAWLORE_WRITE_IDENTITY_REQUIRED: provide exactly one principalKey or sessionKey");
  }

  if (principalKey) {
    if (!isCanonicalPrincipalKey(principalKey)) {
      throw new Error("CLAWLORE_WRITE_IDENTITY_INVALID: principalKey must be an exact platform:account:principal key");
    }
    const identity = runtimePrincipalIdentity(principalKey);
    return {
      contract: CLAWLORE_PRINCIPAL_SCOPE_CONTRACT,
      kind: "private",
      scope: identity.scope,
      principalHash: identity.principalHash,
    };
  }

  const boundary = resolveRuntimeMemoryBoundary({
    runtimeContext: { sessionKey },
  });
  if (boundary.kind === "private" && boundary.scope && boundary.principalHash) {
    return {
      contract: CLAWLORE_PRINCIPAL_SCOPE_CONTRACT,
      kind: "private",
      scope: boundary.scope,
      principalHash: boundary.principalHash,
    };
  }
  if (
    input.allowConversation === true
    && boundary.kind === "conversation"
    && boundary.scope
    && boundary.conversationHash
  ) {
    return {
      contract: CLAWLORE_PRINCIPAL_SCOPE_CONTRACT,
      kind: "conversation",
      scope: boundary.scope,
      conversationHash: boundary.conversationHash,
    };
  }
  const reason = boundary.kind === "conversation"
    ? "conversation writes require an explicit allowConversation policy"
    : "session identity did not resolve to a private principal";
  throw new Error(`CLAWLORE_WRITE_IDENTITY_UNRESOLVED: ${reason}`);
}
