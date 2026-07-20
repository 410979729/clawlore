import type { MemoryAddressV2, MemoryVisibility } from "../v2/domain/memory-address.js";
import { validateMemoryAddress } from "../v2/domain/memory-address.js";

export type MemoryOperation = "recall" | "remember" | "correct" | "forget";
export type MemoryAccessMode = "automatic" | "explicit" | "operator";

export interface MemoryAccessGrant {
  id: string;
  effect: "allow";
  operations: MemoryOperation[];
  subjectPrincipalId: string;
  tenantId: string;
  agentId: string;
  visibility: MemoryVisibility;
  targetPrincipalId?: string;
  conversationId?: string;
  threadId?: string;
  projectId?: string;
}

export type MemoryPolicyReasonCode =
  | "invalid_actor_address"
  | "invalid_target_address"
  | "tenant_mismatch"
  | "agent_mismatch"
  | "private_principal_mismatch"
  | "conversation_mismatch"
  | "thread_mismatch"
  | "project_mismatch"
  | "shared_scope_requires_grant"
  | "same_private_principal"
  | "same_conversation"
  | "same_project"
  | "explicit_grant";

export interface MemoryPolicyDecisionV2 {
  allowed: boolean;
  injectable: boolean;
  reasonCode: MemoryPolicyReasonCode;
  reason: string;
  grantId?: string;
  trace: Array<{ check: string; passed: boolean; detail: string }>;
}

function deny(
  reasonCode: MemoryPolicyReasonCode,
  reason: string,
  trace: MemoryPolicyDecisionV2["trace"],
): MemoryPolicyDecisionV2 {
  return { allowed: false, injectable: false, reasonCode, reason, trace };
}

function matchingGrant(
  actor: MemoryAddressV2,
  target: MemoryAddressV2,
  operation: MemoryOperation,
  grants: MemoryAccessGrant[],
): MemoryAccessGrant | undefined {
  return grants.find((grant) => {
    if (
      !grant.id?.trim()
      || grant.effect !== "allow"
      || !Array.isArray(grant.operations)
      || !grant.operations.includes(operation)
      || grant.subjectPrincipalId !== actor.principalId
      || grant.tenantId !== target.tenantId
      || grant.agentId !== target.agentId
      || grant.visibility !== target.visibility
    ) return false;

    // Shared visibility alone is never a sufficient selector for a narrower
    // private/conversation/project resource. Grants must bind the exact target
    // boundary so one authorization cannot silently fan out to peer records.
    if (target.visibility === "private") {
      return grant.targetPrincipalId === target.principalId;
    }
    if (target.visibility === "conversation") {
      return grant.conversationId === target.conversationId
        && (!target.threadId || grant.threadId === target.threadId);
    }
    if (target.visibility === "project") {
      return grant.projectId === target.projectId;
    }
    return true;
  });
}

export function decideMemoryAccess(input: {
  actor: MemoryAddressV2;
  target: MemoryAddressV2;
  operation: MemoryOperation;
  mode: MemoryAccessMode;
  grants?: MemoryAccessGrant[];
}): MemoryPolicyDecisionV2 {
  const trace: MemoryPolicyDecisionV2["trace"] = [];
  const actorValidation = validateMemoryAddress(input.actor);
  trace.push({ check: "actor_address_valid", passed: actorValidation.valid, detail: actorValidation.valid ? "valid" : actorValidation.errors.map((error) => error.message).join("; ") });
  if (!actorValidation.valid) return deny("invalid_actor_address", "actor address is invalid", trace);

  const targetValidation = validateMemoryAddress(input.target);
  trace.push({ check: "target_address_valid", passed: targetValidation.valid, detail: targetValidation.valid ? "valid" : targetValidation.errors.map((error) => error.message).join("; ") });
  if (!targetValidation.valid) return deny("invalid_target_address", "target address is invalid", trace);

  const sameTenant = input.actor.tenantId === input.target.tenantId;
  trace.push({ check: "same_tenant", passed: sameTenant, detail: `${input.actor.tenantId} -> ${input.target.tenantId}` });
  if (!sameTenant) return deny("tenant_mismatch", "cross-tenant access is denied", trace);

  const sameAgent = input.actor.agentId === input.target.agentId;
  trace.push({ check: "same_agent", passed: sameAgent, detail: `${input.actor.agentId} -> ${input.target.agentId}` });
  const grant = matchingGrant(input.actor, input.target, input.operation, input.grants ?? []);
  if (!sameAgent && !grant) return deny("agent_mismatch", "cross-agent access requires an explicit grant", trace);

  if (input.target.visibility === "private") {
    const samePrincipal = input.actor.principalId === input.target.principalId;
    trace.push({ check: "same_private_principal", passed: samePrincipal, detail: samePrincipal ? "same principal" : "different principal" });
    if (!samePrincipal && !grant) return deny("private_principal_mismatch", "private memory belongs to another principal", trace);
    return grant
      ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
      : { allowed: true, injectable: true, reasonCode: "same_private_principal", reason: "private memory belongs to the current principal", trace };
  }

  if (input.target.visibility === "conversation") {
    const sameConversation = Boolean(input.actor.conversationId) && input.actor.conversationId === input.target.conversationId;
    trace.push({ check: "same_conversation", passed: sameConversation, detail: `${input.actor.conversationId ?? "missing"} -> ${input.target.conversationId ?? "missing"}` });
    if (!sameConversation && !grant) return deny("conversation_mismatch", "conversation memory is outside the current conversation", trace);
    const sameThread = !input.target.threadId || input.actor.threadId === input.target.threadId;
    trace.push({ check: "same_thread", passed: sameThread, detail: `${input.actor.threadId ?? "none"} -> ${input.target.threadId ?? "none"}` });
    if (!sameThread && !grant) return deny("thread_mismatch", "thread-scoped memory is outside the current thread", trace);
    return grant
      ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
      : { allowed: true, injectable: true, reasonCode: "same_conversation", reason: "memory belongs to the current conversation boundary", trace };
  }

  if (input.target.visibility === "project") {
    const sameProject = Boolean(input.actor.projectId) && input.actor.projectId === input.target.projectId;
    trace.push({ check: "same_project", passed: sameProject, detail: `${input.actor.projectId ?? "missing"} -> ${input.target.projectId ?? "missing"}` });
    if (!sameProject && !grant) return deny("project_mismatch", "project memory is outside the current project", trace);
    return grant
      ? { allowed: true, injectable: input.mode !== "automatic", reasonCode: "explicit_grant", reason: "access allowed by explicit grant", grantId: grant.id, trace }
      : { allowed: true, injectable: true, reasonCode: "same_project", reason: "memory belongs to the current project boundary", trace };
  }

  trace.push({ check: "shared_scope_grant", passed: Boolean(grant), detail: grant?.id ?? "missing" });
  if (!grant) return deny("shared_scope_requires_grant", `${input.target.visibility} memory requires an explicit grant`, trace);
  return {
    allowed: true,
    injectable: input.mode !== "automatic",
    reasonCode: "explicit_grant",
    reason: "access allowed by explicit grant; automatic injection remains disabled",
    grantId: grant.id,
    trace,
  };
}
