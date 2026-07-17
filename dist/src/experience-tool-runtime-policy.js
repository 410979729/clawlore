/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */
import { Type } from "@sinclair/typebox";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { CAPABILITY_CLASSES, PLAYBOOK_STATUSES } from "./experience-models.js";
import { resolveRuntimeMemoryAccess, } from "./runtime-memory-boundary.js";
import { isSystemBypassId, parseAgentIdFromSessionKey } from "./scopes.js";
export function safeExperienceToolFailure(code, label, error) {
    console.warn(`clawlore: experience tool ${code}: ${diagnosticErrorSummary(error)}`);
    return {
        content: [{ type: "text", text: `${label}. Reference: ${code}` }],
        details: { error: code },
        isError: true,
    };
}
export const EXPERIENCE_TOOL_NAMES = [
    "scope_recall_episode_create",
    "scope_recall_episode_complete",
    "scope_recall_playbook_search",
    "scope_recall_playbook_inspect",
    "scope_recall_playbook_create",
    "scope_recall_playbook_feedback",
    "scope_recall_playbook_review",
    "scope_recall_experience_preflight",
    "scope_recall_experience_stats",
    "scope_recall_experience_promote",
    "scope_recall_experience_replay",
    "scope_recall_forgetting_report",
    "scope_recall_forgetting_run",
    "scope_recall_governance_cleanup_report",
    "scope_recall_governance_cleanup_run",
    "scope_recall_memory_candidate_promotion_report",
    "scope_recall_memory_candidate_promotion_run",
    "scope_recall_graph_hygiene_report",
    "scope_recall_graph_hygiene_run",
    "scope_recall_journal_recovery_report",
    "scope_recall_journal_recovery_run",
    "scope_recall_operator_dashboard",
    "scope_recall_digest_report",
    "scope_recall_digest_run",
    "scope_recall_digest_recovery",
];
export function resolveRuntimeAgentId(staticAgentId, toolCtx, runtimeCtx) {
    const candidates = [runtimeCtx, toolCtx];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object")
            continue;
        const record = candidate;
        if (typeof record.agentId === "string" && record.agentId.trim()) {
            return record.agentId.trim();
        }
        const fromSession = parseAgentIdFromSessionKey(typeof record.sessionKey === "string" ? record.sessionKey : undefined);
        if (fromSession)
            return fromSession;
    }
    return staticAgentId?.trim() || undefined;
}
export function missingAgentContextResponse(toolName) {
    return {
        content: [
            {
                type: "text",
                text: `${toolName} requires OpenClaw agent runtime context; refusing to use a shared default Experience scope.`,
            },
        ],
        details: { error: "missing_agent_context", tool: toolName },
        isError: true,
    };
}
export function deniedExperienceBoundaryResponse(toolName, reason) {
    return {
        content: [{
                type: "text",
                text: reason === "group_memory_denied"
                    ? `${toolName} is disabled in group and channel conversations.`
                    : `${toolName} requires a resolvable private or explicitly enabled conversation boundary.`,
            }],
        details: { error: "memory_boundary_denied", reason, tool: toolName },
        isError: true,
    };
}
export function resolveExperienceRuntime(context, toolCtx, runtimeCtx, toolName) {
    const agentId = resolveRuntimeAgentId(context.agentId, toolCtx, runtimeCtx);
    if (!agentId)
        return { ok: false, response: missingAgentContextResponse(toolName) };
    const access = resolveRuntimeMemoryAccess({
        scopeManager: context.scopeManager,
        agentId,
        config: context.principalIsolation,
        staticContext: toolCtx,
        runtimeContext: runtimeCtx,
    });
    if (access.denied) {
        return { ok: false, response: deniedExperienceBoundaryResponse(toolName, access.denyReason) };
    }
    const defaultScope = access.defaultScope ?? context.scopeManager.getDefaultScope(agentId);
    const scopeFilter = access.scopeFilter;
    const sessionId = (runtimeCtx && typeof runtimeCtx === "object" && typeof runtimeCtx.sessionId === "string"
        ? String(runtimeCtx.sessionId)
        : "") ||
        (toolCtx && typeof toolCtx === "object" && typeof toolCtx.sessionId === "string"
            ? String(toolCtx.sessionId)
            : "") ||
        "unknown";
    return {
        ok: true,
        agentId,
        defaultScope,
        scopeFilter,
        sessionId,
        systemBypass: isSystemBypassId(agentId),
        isAccessible: access.isAccessible,
    };
}
export function globalExperienceOperatorDeniedResponse(toolName) {
    return {
        content: [{
                type: "text",
                text: `${toolName} requires an explicit system operator context because its underlying operation is not scope-local.`,
            }],
        details: { error: "system_operator_context_required", tool: toolName },
        isError: true,
    };
}
export function registerExperienceTool(api, name, factory) {
    api.registerTool(factory, { name });
}
export function managementDisabledResponse(toolName) {
    return {
        content: [{ type: "text", text: `${toolName} requires enableManagementTools=true.` }],
        details: { error: "management_tools_disabled", tool: toolName },
        isError: true,
    };
}
export function stringEnum(values) {
    return Type.Unsafe({
        type: "string",
        enum: [...values],
    });
}
export const PLAYBOOK_STATUS_VALUES = [...PLAYBOOK_STATUSES];
export const CAPABILITY_CLASS_VALUES = [...CAPABILITY_CLASSES];
// ============================================================================
// Episode Tools
// ============================================================================
