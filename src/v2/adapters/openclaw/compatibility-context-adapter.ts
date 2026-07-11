import {
  composeContextPack,
  renderCompatibilityContextPack,
  type ContextCandidateV1,
} from "../../application/context-composer.js";
import {
  resolveMemoryIdentity,
  type IdentityResolution,
  type IdentityResolverInput,
} from "../../application/identity-resolver.js";
import { decideMemoryAccess, type MemoryPolicyDecisionV2 } from "../../application/policy-decision.js";
import type { ContextPackV1 } from "../../domain/context-pack.js";
import type { MemoryAddressV2 } from "../../domain/memory-address.js";

export interface CompatibilityRetrievalBoundaryV1 {
  tenantId: string;
  principalId: string;
  agentId: string;
  visibility: MemoryAddressV2["visibility"];
  workspaceId?: string;
  projectId?: string;
  platform?: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string;
  customerId?: string;
  taskId?: string;
}

export interface CompatibilityContextShadowInput {
  traceId: string;
  availableTokens: number;
  identity: IdentityResolverInput;
  retrieveCandidates(boundary: CompatibilityRetrievalBoundaryV1): Promise<ContextCandidateV1[]>;
}

export interface CompatibilityContextShadowResult {
  schemaVersion: 1;
  mode: "shadow";
  identity: IdentityResolution;
  preflight?: MemoryPolicyDecisionV2;
  retrievalBoundary?: CompatibilityRetrievalBoundaryV1;
  retrievalInvoked: boolean;
  pack?: ContextPackV1;
  renderedContext?: string;
  hookResult?: undefined;
  trace: Array<{
    stage: "identity" | "policy_preflight" | "candidate_retrieval" | "compose";
    outcome: "pass" | "skip";
    detail: string;
  }>;
}

function retrievalBoundary(address: MemoryAddressV2): CompatibilityRetrievalBoundaryV1 {
  return {
    tenantId: address.tenantId,
    principalId: address.principalId,
    agentId: address.agentId,
    visibility: address.visibility,
    ...(address.workspaceId ? { workspaceId: address.workspaceId } : {}),
    ...(address.projectId ? { projectId: address.projectId } : {}),
    ...(address.platform ? { platform: address.platform } : {}),
    ...(address.accountId ? { accountId: address.accountId } : {}),
    ...(address.conversationId ? { conversationId: address.conversationId } : {}),
    ...(address.threadId ? { threadId: address.threadId } : {}),
    ...(address.customerId ? { customerId: address.customerId } : {}),
    ...(address.taskId ? { taskId: address.taskId } : {}),
  };
}

export async function runCompatibilityContextShadow(
  input: CompatibilityContextShadowInput,
): Promise<CompatibilityContextShadowResult> {
  const identity = resolveMemoryIdentity(input.identity);
  const trace: CompatibilityContextShadowResult["trace"] = [];
  if (identity.status !== "resolved" || !identity.address) {
    trace.push({ stage: "identity", outcome: "skip", detail: identity.missing.join(",") || "invalid_address" });
    return {
      schemaVersion: 1,
      mode: "shadow",
      identity,
      retrievalInvoked: false,
      trace,
    };
  }
  trace.push({ stage: "identity", outcome: "pass", detail: identity.address.principalId });

  const preflight = decideMemoryAccess({
    actor: identity.address,
    target: identity.address,
    operation: "recall",
    mode: "automatic",
  });
  if (!preflight.allowed || !preflight.injectable) {
    trace.push({ stage: "policy_preflight", outcome: "skip", detail: preflight.reasonCode });
    return {
      schemaVersion: 1,
      mode: "shadow",
      identity,
      preflight,
      retrievalInvoked: false,
      trace,
    };
  }
  trace.push({ stage: "policy_preflight", outcome: "pass", detail: preflight.reasonCode });

  const boundary = retrievalBoundary(identity.address);
  const candidates = await input.retrieveCandidates(boundary);
  trace.push({ stage: "candidate_retrieval", outcome: "pass", detail: `${candidates.length}_candidates` });

  const pack = composeContextPack({
    traceId: input.traceId,
    actorAddress: identity.address,
    availableTokens: input.availableTokens,
    candidates,
  });
  trace.push({ stage: "compose", outcome: "pass", detail: `${pack.trace.selectedCount}_selected` });
  return {
    schemaVersion: 1,
    mode: "shadow",
    identity,
    preflight,
    retrievalBoundary: boundary,
    retrievalInvoked: true,
    pack,
    renderedContext: renderCompatibilityContextPack(pack),
    hookResult: undefined,
    trace,
  };
}
