import { composeContextPack, renderCompatibilityContextPack, } from "../../application/context-composer.js";
import { resolveMemoryIdentity, } from "../../application/identity-resolver.js";
import { decideMemoryAccess } from "../../application/policy-decision.js";
function retrievalBoundary(address) {
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
export async function runCompatibilityContextShadow(input) {
    const identity = resolveMemoryIdentity(input.identity);
    const trace = [];
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
    const candidates = await input.retrieveCandidates({ boundary, queryText });
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
