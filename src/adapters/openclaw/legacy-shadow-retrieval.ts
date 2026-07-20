import type { ContextCandidateV1 } from "../../application/context-composer.js";
import type { MemoryAddressV2 } from "../../v2/domain/memory-address.js";
import { adaptLegacyContextSources } from "./legacy-context-sources.js";
import type { CompatibilityRetrievalRequestV1 } from "./compatibility-context-adapter.js";
import { filterUnsafeMemoryResults } from "../../memory-egress-policy.js";

export interface LegacyShadowRetrievalResultV1 {
  entry: {
    id: string;
    text: string;
    category?: string;
    scope: string;
    metadata?: string;
  };
  score?: number;
}

export interface LegacyShadowRetrievalDependenciesV1 {
  workspaceId?: string;
  candidateLimit: number;
  resolveScopeFilter(agentId: string): string[] | undefined;
  retrieve(input: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    source: "auto-recall";
    signal?: AbortSignal;
  }): Promise<LegacyShadowRetrievalResultV1[]>;
}

function actorAddress(request: CompatibilityRetrievalRequestV1): MemoryAddressV2 {
  const boundary = request.boundary;
  return {
    schemaVersion: 2,
    tenantId: boundary.tenantId,
    principalId: boundary.principalId,
    agentId: boundary.agentId,
    ...(boundary.workspaceId ? { workspaceId: boundary.workspaceId } : {}),
    ...(boundary.projectId ? { projectId: boundary.projectId } : {}),
    ...(boundary.platform ? { platform: boundary.platform } : {}),
    ...(boundary.accountId ? { accountId: boundary.accountId } : {}),
    ...(boundary.conversationId ? { conversationId: boundary.conversationId } : {}),
    ...(boundary.threadId ? { threadId: boundary.threadId } : {}),
    ...(boundary.customerId ? { customerId: boundary.customerId } : {}),
    ...(boundary.taskId ? { taskId: boundary.taskId } : {}),
    visibility: boundary.visibility,
    retention: "working",
  };
}

export function createLegacyShadowCandidateRetrieverV1(
  dependencies: LegacyShadowRetrievalDependenciesV1,
): (request: CompatibilityRetrievalRequestV1) => Promise<ContextCandidateV1[]> {
  return async (request) => {
    const query = request.queryText.trim();
    if (!query) return [];
    const scopeFilter = dependencies.resolveScopeFilter(request.boundary.agentId);
    const results = await dependencies.retrieve({
      query,
      limit: dependencies.candidateLimit,
      scopeFilter,
      source: "auto-recall",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return adaptLegacyContextSources({
      autoRecall: filterUnsafeMemoryResults(results).map((result) => ({
        id: result.entry.id,
        text: result.entry.text,
        category: result.entry.category,
        scope: result.entry.scope,
        metadata: result.entry.metadata,
        score: result.score,
      })),
      inheritedRules: [],
      derivedFocus: [],
      errorSignals: [],
    }, {
      tenantId: request.boundary.tenantId,
      agentId: request.boundary.agentId,
      workspaceId: dependencies.workspaceId ?? request.boundary.workspaceId,
      actorAddress: actorAddress(request),
    }).candidates;
  };
}
