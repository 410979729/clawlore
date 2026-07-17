import { createHash } from "node:crypto";
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
import type { ContextPackV1 } from "../../v2/domain/context-pack.js";
import type { MemoryAddressV2 } from "../../v2/domain/memory-address.js";

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

export interface CompatibilityRetrievalRequestV1 {
  boundary: CompatibilityRetrievalBoundaryV1;
  queryText: string;
  signal?: AbortSignal;
}

export interface CompatibilityShadowComparisonV1 {
  status: "completed" | "failed";
  primaryCandidateCount: number;
  comparisonCandidateCount: number;
  overlapRatio: number;
  rankAgreement: number;
  primaryLatencyMs: number;
  comparisonLatencyMs: number;
  primaryIdsDigest: string;
  comparisonIdsDigest: string;
}

export interface CompatibilityContextShadowInput {
  traceId: string;
  ingressKind?: "direct" | "group" | "channel" | "unknown";
  availableTokens: number;
  queryText?: string;
  identity: IdentityResolverInput;
  retrieveCandidates(request: CompatibilityRetrievalRequestV1): Promise<ContextCandidateV1[]>;
  retrieveComparisonCandidates?(request: CompatibilityRetrievalRequestV1): Promise<ContextCandidateV1[]>;
  signal?: AbortSignal;
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
  comparison?: CompatibilityShadowComparisonV1;
  hookResult?: undefined;
  trace: Array<{
    stage: "identity" | "policy_preflight" | "candidate_retrieval" | "compose";
    outcome: "pass" | "skip";
    detail: string;
  }>;
}

function comparisonId(id: string): string {
  return id.startsWith("legacy:") ? id.slice("legacy:".length) : id;
}

function idsDigest(ids: string[]): string {
  return createHash("sha256").update(JSON.stringify(ids.map(comparisonId))).digest("hex");
}

function comparisonMetrics(
  primary: ContextCandidateV1[],
  comparison: ContextCandidateV1[],
  primaryLatencyMs: number,
  comparisonLatencyMs: number,
): CompatibilityShadowComparisonV1 {
  const primaryIds = primary.map((item) => comparisonId(item.id));
  const comparisonIds = comparison.map((item) => comparisonId(item.id));
  const comparisonRank = new Map(comparisonIds.map((id, index) => [id, index]));
  const shared = primaryIds.map((id, index) => ({ index, other: comparisonRank.get(id) }))
    .filter((entry): entry is { index: number; other: number } => entry.other !== undefined);
  const denominator = Math.max(primaryIds.length, comparisonIds.length, 1);
  const span = Math.max(primaryIds.length, comparisonIds.length, 2) - 1;
  return {
    status: "completed",
    primaryCandidateCount: primaryIds.length,
    comparisonCandidateCount: comparisonIds.length,
    overlapRatio: shared.length / denominator,
    rankAgreement: shared.reduce((sum, entry) => sum + (1 - Math.abs(entry.index - entry.other) / span), 0) / denominator,
    primaryLatencyMs,
    comparisonLatencyMs,
    primaryIdsDigest: idsDigest(primaryIds),
    comparisonIdsDigest: idsDigest(comparisonIds),
  };
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
  const queryText = typeof input.queryText === "string" ? input.queryText.trim() : "";
  if (!queryText) {
    trace.push({ stage: "candidate_retrieval", outcome: "skip", detail: "query_unavailable" });
    return {
      schemaVersion: 1,
      mode: "shadow",
      identity,
      preflight,
      retrievalBoundary: boundary,
      retrievalInvoked: false,
      trace,
    };
  }
  const request = { boundary, queryText, ...(input.signal ? { signal: input.signal } : {}) };
  const primaryStartedAt = Date.now();
  const primaryPromise = input.retrieveCandidates(request).then((candidates) => ({
    candidates,
    latencyMs: Date.now() - primaryStartedAt,
  }));
  const comparisonStartedAt = Date.now();
  const comparisonPromise = input.retrieveComparisonCandidates
    ? input.retrieveComparisonCandidates(request)
      .then((candidates) => ({ candidates, latencyMs: Date.now() - comparisonStartedAt }))
      .catch(() => undefined)
    : Promise.resolve(undefined);
  const [primary, comparison] = await Promise.all([primaryPromise, comparisonPromise]);
  const candidates = primary.candidates;
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
    ...(input.retrieveComparisonCandidates
      ? { comparison: comparison
        ? comparisonMetrics(candidates, comparison.candidates, primary.latencyMs, comparison.latencyMs)
        : {
            status: "failed" as const,
            primaryCandidateCount: candidates.length,
            comparisonCandidateCount: 0,
            overlapRatio: 0,
            rankAgreement: 0,
            primaryLatencyMs: primary.latencyMs,
            comparisonLatencyMs: Date.now() - comparisonStartedAt,
            primaryIdsDigest: idsDigest(candidates.map((item) => item.id)),
            comparisonIdsDigest: idsDigest([]),
          } }
      : {}),
    hookResult: undefined,
    trace,
  };
}
