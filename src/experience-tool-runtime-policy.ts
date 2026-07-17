/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import type { TextEmbedder } from "./embedder.js";
import { CAPABILITY_CLASSES, PLAYBOOK_STATUSES } from "./experience-models.js";
import type { MemoryRetriever } from "./retriever.js";
import {
  resolveRuntimeMemoryAccess,
  type PrincipalIsolationConfig,
} from "./runtime-memory-boundary.js";
import type { MemoryScopeManager } from "./scopes.js";
import { isSystemBypassId, parseAgentIdFromSessionKey } from "./scopes.js";
import type { MemoryStore } from "./store.js";
import type { MdMirrorWriter } from "./tools.js";
import type { WorkspaceBoundaryConfig } from "./workspace-boundary.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
export type DatabaseSync = any;

// ============================================================================
// Tool Context
// ============================================================================

export interface ExperienceToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: TextEmbedder;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  principalIsolation?: PrincipalIsolationConfig;
  db: () => Promise<DatabaseSync>;
}

export interface ExperienceToolsOptions {
  enableManagementTools?: boolean;
}

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

export function safeExperienceToolFailure(code: string, label: string, error: unknown): ToolTextResult {
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
] as const;

export function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  toolCtx: unknown,
  runtimeCtx: unknown,
): string | undefined {
  const candidates = [runtimeCtx, toolCtx];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.agentId === "string" && record.agentId.trim()) {
      return record.agentId.trim();
    }
    const fromSession = parseAgentIdFromSessionKey(
      typeof record.sessionKey === "string" ? record.sessionKey : undefined,
    );
    if (fromSession) return fromSession;
  }
  return staticAgentId?.trim() || undefined;
}

export function missingAgentContextResponse(toolName: string): ToolTextResult {
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

export function deniedExperienceBoundaryResponse(toolName: string, reason?: string): ToolTextResult {
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

export function resolveExperienceRuntime(
  context: ExperienceToolContext,
  toolCtx: unknown,
  runtimeCtx: unknown,
  toolName: string,
): {
  ok: true;
  agentId: string;
  defaultScope: string;
  scopeFilter: string[] | undefined;
  sessionId: string;
  systemBypass: boolean;
  isAccessible(scope: string): boolean;
} | { ok: false; response: ToolTextResult } {
  const agentId = resolveRuntimeAgentId(context.agentId, toolCtx, runtimeCtx);
  if (!agentId) return { ok: false, response: missingAgentContextResponse(toolName) };
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
  const sessionId =
    (runtimeCtx && typeof runtimeCtx === "object" && typeof (runtimeCtx as Record<string, unknown>).sessionId === "string"
      ? String((runtimeCtx as Record<string, unknown>).sessionId)
      : "") ||
    (toolCtx && typeof toolCtx === "object" && typeof (toolCtx as Record<string, unknown>).sessionId === "string"
      ? String((toolCtx as Record<string, unknown>).sessionId)
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

export function globalExperienceOperatorDeniedResponse(toolName: string): ToolTextResult {
  return {
    content: [{
      type: "text",
      text: `${toolName} requires an explicit system operator context because its underlying operation is not scope-local.`,
    }],
    details: { error: "system_operator_context_required", tool: toolName },
    isError: true,
  };
}

export function registerExperienceTool(
  api: OpenClawPluginApi,
  name: typeof EXPERIENCE_TOOL_NAMES[number],
  factory: (toolCtx?: Record<string, unknown>) => unknown,
): void {
  api.registerTool(factory, { name });
}

export function managementDisabledResponse(toolName: string): ToolTextResult {
  return {
    content: [{ type: "text", text: `${toolName} requires enableManagementTools=true.` }],
    details: { error: "management_tools_disabled", tool: toolName },
    isError: true,
  };
}

export function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

export const PLAYBOOK_STATUS_VALUES = [...PLAYBOOK_STATUSES] as [string, ...string[]];
export const CAPABILITY_CLASS_VALUES = [...CAPABILITY_CLASSES] as [string, ...string[]];

// ============================================================================
// Episode Tools
// ============================================================================
