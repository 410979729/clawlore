import { validateMemoryAddress } from "../domain/memory-address.js";
function deny(reasonCode, reason, trace) {
    return { allowed: false, injectable: false, reasonCode, reason, trace };
}
function matchingGrant(actor, target, operation, grants) {
    return grants.find((grant) => grant.effect === "allow"
        && grant.operations.includes(operation)
        && grant.subjectPrincipalId === actor.principalId
        && grant.tenantId === target.tenantId
        && (!grant.agentId || grant.agentId === target.agentId)
        && (!grant.visibility || grant.visibility === target.visibility)
        && (!grant.conversationId || grant.conversationId === target.conversationId)
        && (!grant.projectId || grant.projectId === target.projectId));
}
export function decideMemoryAccess(input) {
    const trace = [];
    const actorValidation = validateMemoryAddress(input.actor);
    trace.push({ check: "actor_address_valid", passed: actorValidation.valid, detail: actorValidation.valid ? "valid" : actorValidation.errors.map((error) => error.message).join("; ") });
    if (!actorValidation.valid)
        return deny("invalid_actor_address", "actor address is invalid", trace);
    const targetValidation = validateMemoryAddress(input.target);
    trace.push({ check: "target_address_valid", passed: targetValidation.valid, detail: targetValidation.valid ? "valid" : targetValidation.errors.map((error) => error.message).join("; ") });
    if (!targetValidation.valid)
        return deny("invalid_target_address", "target address is invalid", trace);
    const sameTenant = input.actor.tenantId === input.target.tenantId;
    trace.push({ check: "same_tenant", passed: sameTenant, detail: `${input.actor.tenantId} -> ${input.target.tenantId}` });
    if (!sameTenant)
        return deny("tenant_mismatch", "cross-tenant access is denied", trace);
    const sameAgent = input.actor.agentId === input.target.agentId;
    trace.push({ check: "same_agent", passed: sameAgent, detail: `${input.actor.agentId} -> ${input.target.agentId}` });
    const grant = matchingGrant(input.actor, input.target, input.operation, input.grants ?? []);
    if (!sameAgent && !grant)
        return deny("agent_mismatch", "cross-agent access requires an explicit grant", trace);
    if (input.target.visibility === "private") {
        const samePrincipal = input.actor.principalId === input.target.principalId;
        trace.push({ check: "same_private_principal", passed: samePrincipal, detail: samePrincipal ? "same principal" : "different principal" });
        if (!samePrincipal && !grant)
            return deny("private_principal_mismatch", "private memory belongs to another principal", trace);
        return grant
            ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
            : { allowed: true, injectable: true, reasonCode: "same_private_principal", reason: "private memory belongs to the current principal", trace };
    }
    if (input.target.visibility === "conversation") {
        const sameConversation = Boolean(input.actor.conversationId) && input.actor.conversationId === input.target.conversationId;
        trace.push({ check: "same_conversation", passed: sameConversation, detail: `${input.actor.conversationId ?? "missing"} -> ${input.target.conversationId ?? "missing"}` });
        if (!sameConversation && !grant)
            return deny("conversation_mismatch", "conversation memory is outside the current conversation", trace);
        const sameThread = !input.target.threadId || input.actor.threadId === input.target.threadId;
        trace.push({ check: "same_thread", passed: sameThread, detail: `${input.actor.threadId ?? "none"} -> ${input.target.threadId ?? "none"}` });
        if (!sameThread && !grant)
            return deny("thread_mismatch", "thread-scoped memory is outside the current thread", trace);
        return grant
            ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
            : { allowed: true, injectable: true, reasonCode: "same_conversation", reason: "memory belongs to the current conversation boundary", trace };
    }
    if (input.target.visibility === "project") {
        const sameProject = Boolean(input.actor.projectId) && input.actor.projectId === input.target.projectId;
        trace.push({ check: "same_project", passed: sameProject, detail: `${input.actor.projectId ?? "missing"} -> ${input.target.projectId ?? "missing"}` });
        if (!sameProject && !grant)
            return deny("project_mismatch", "project memory is outside the current project", trace);
        return grant
            ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
            : { allowed: true, injectable: true, reasonCode: "same_project", reason: "memory belongs to the current project boundary", trace };
    }
    trace.push({ check: "shared_scope_grant", passed: Boolean(grant), detail: grant?.id ?? "missing" });
    if (!grant)
        return deny("shared_scope_requires_grant", `${input.target.visibility} memory requires an explicit grant`, trace);
    return {
        allowed: true,
        injectable: input.mode !== "automatic",
        reasonCode: "explicit_grant",
        reason: "access allowed by explicit grant; automatic injection remains disabled",
        grantId: grant.id,
        trace,
    };
}
