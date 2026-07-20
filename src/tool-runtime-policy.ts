/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import type { TextEmbedder } from "./embedder.js";
import { redactMemoryTextForOutput } from "./memory-egress-policy.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import {
  resolveRuntimeMemoryAccess,
  type PrincipalIsolationConfig,
  type RuntimeMemoryAccess
} from "./runtime-memory-boundary.js";
import { parseAgentIdFromSessionKey, type MemoryScopeManager } from "./scopes.js";
import {
  parseSmartMetadata
} from "./smart-metadata.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import {
  type WorkspaceBoundaryConfig
} from "./workspace-boundary.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}
export type MdMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

export interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: TextEmbedder;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  principalIsolation?: PrincipalIsolationConfig;
}

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

// ============================================================================
// Utility Functions
// ============================================================================

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function safeToolFailure(code: string, label: string, error: unknown): ToolTextResult {
  console.warn(`clawlore: tool ${code}: ${diagnosticErrorSummary(error)}`);
  return {
    content: [{ type: "text", text: `${label}. Reference: ${code}` }],
    details: { error: code },
    isError: true,
  };
}

export function normalizeInlineText(text: string): string {
  return redactMemoryTextForOutput(text).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

export function deriveManualMemoryLayer(category: string): "durable" | "working" {
  if (category === "preference" || category === "decision" || category === "fact") {
    return "durable";
  }
  return "working";
}

export function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: redactMemoryTextForOutput(r.entry.text),
    category: getDisplayCategoryTag(r.entry),
    rawCategory: r.entry.category,
    scope: redactMemoryTextForOutput(r.entry.scope),
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
}

export function serializeMemoryEntry(entry: MemoryEntry, includeFullText = false) {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  const base = {
    id: entry.id,
    text: includeFullText
      ? redactMemoryTextForOutput(metadata.l2_content || metadata.l1_overview || entry.text)
      : truncateText(normalizeInlineText(metadata.l0_abstract || entry.text), 220),
    category: getDisplayCategoryTag(entry),
    rawCategory: entry.category,
    scope: redactMemoryTextForOutput(entry.scope),
    importance: entry.importance,
    timestamp: entry.timestamp,
    state: metadata.state,
    layer: metadata.memory_layer,
    source: metadata.source,
    tier: metadata.tier,
    confidence: metadata.confidence,
    factKey: metadata.fact_key ? redactMemoryTextForOutput(metadata.fact_key) : undefined,
    validFrom: metadata.valid_from,
    invalidatedAt: metadata.invalidated_at,
    supersedes: metadata.supersedes ? redactMemoryTextForOutput(metadata.supersedes) : undefined,
    supersededBy: metadata.superseded_by ? redactMemoryTextForOutput(metadata.superseded_by) : undefined,
    canonicalId: metadata.canonical_id ? redactMemoryTextForOutput(metadata.canonical_id) : undefined,
    relations: (metadata.relations ?? []).map((relation) => ({
      type: redactMemoryTextForOutput(relation.type),
      targetId: redactMemoryTextForOutput(relation.targetId),
    })),
  };
  return includeFullText
    ? {
      ...base,
      l0Abstract: redactMemoryTextForOutput(metadata.l0_abstract),
      l1Overview: redactMemoryTextForOutput(metadata.l1_overview),
      l2Content: redactMemoryTextForOutput(metadata.l2_content),
    }
    : base;
}

export function renderMemoryEntry(entry: MemoryEntry, index?: number, includeFullText = false): string {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  const prefix = index === undefined ? "" : `${index + 1}. `;
  const categoryTag = getDisplayCategoryTag(entry);
  const date = new Date(entry.timestamp).toISOString().split("T")[0];
  const sourceBits = [
    metadata.state,
    metadata.memory_layer,
    metadata.source,
    metadata.tier,
  ].filter(Boolean).join("/");
  const text = includeFullText
    ? normalizeInlineText(metadata.l2_content || metadata.l1_overview || entry.text)
    : truncateText(normalizeInlineText(metadata.l0_abstract || entry.text), 180);
  return `${prefix}[${entry.id}] [${categoryTag}:${normalizeInlineText(entry.scope)}] ${text} (${date}; ${sourceBits})`;
}

export function memoryMetadataMatches(
  entry: MemoryEntry,
  filters: {
    source?: string;
    state?: string;
    layer?: string;
  },
): boolean {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  if (filters.source && metadata.source !== filters.source) return false;
  if (filters.state && metadata.state !== filters.state) return false;
  if (filters.layer && metadata.memory_layer !== filters.layer) return false;
  return true;
}

const _warnedMissingAgentId = new Set<string>();

/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState(): void {
  _warnedMissingAgentId.clear();
}

export function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  runtimeCtx: unknown,
): string | undefined {
  if (!runtimeCtx || typeof runtimeCtx !== "object") {
    const fallback = staticAgentId?.trim();
    if (!fallback && !_warnedMissingAgentId.has("no-context")) {
      _warnedMissingAgentId.add("no-context");
      console.warn(
        "resolveRuntimeAgentId: no runtime context or static agentId; refusing implicit agent:main scope.",
      );
    }
    return fallback || undefined;
  }
  const ctx = runtimeCtx as Record<string, unknown>;
  const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
  const trimmed = resolved?.trim();
  if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
    _warnedMissingAgentId.add("empty-resolved");
    console.warn(
      "resolveRuntimeAgentId: resolved agentId is empty after trim; refusing implicit agent:main scope."
    );
  }
  return trimmed ? trimmed : undefined;
}

export function resolveToolContext(
  base: ToolContext,
  runtimeCtx: unknown,
): ToolContext {
  return {
    ...base,
    agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx),
  };
}

export function missingAgentContextResponse(toolName: string): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text: `${toolName} requires OpenClaw agent runtime context; refusing to fall back to agent:main.`,
      },
    ],
    details: {
      error: "missing_agent_context",
      tool: toolName,
    },
  };
}

export function requireRuntimeAgentId(
  staticAgentId: string | undefined,
  runtimeCtx: unknown,
  toolName: string,
): { ok: true; agentId: string } | { ok: false; response: ToolTextResult } {
  const agentId = resolveRuntimeAgentId(staticAgentId, runtimeCtx);
  if (agentId) return { ok: true, agentId };
  return { ok: false, response: missingAgentContextResponse(toolName) };
}

export function deniedMemoryBoundaryResponse(
  toolName: string,
  access: RuntimeMemoryAccess,
): ToolTextResult {
  return {
    content: [{
      type: "text",
      text: access.denyReason === "group_memory_denied"
        ? `${toolName} is disabled in group and channel conversations.`
        : `${toolName} requires a resolvable private or explicitly enabled conversation boundary.`,
    }],
    details: {
      error: "memory_boundary_denied",
      reason: access.denyReason,
      boundary: access.boundary.kind,
      tool: toolName,
    },
  };
}

export function requireRuntimeMemoryAccess(
  context: ToolContext,
  agentId: string,
  staticContext: unknown,
  runtimeContext: unknown,
  toolName: string,
): { ok: true; access: RuntimeMemoryAccess } | { ok: false; response: ToolTextResult } {
  const access = resolveRuntimeMemoryAccess({
    scopeManager: context.scopeManager,
    agentId,
    config: context.principalIsolation,
    staticContext,
    runtimeContext,
  });
  if (access.denied) {
    return { ok: false, response: deniedMemoryBoundaryResponse(toolName, access) };
  }
  return { ok: true, access };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function retrieveWithRetry(
  retriever: MemoryRetriever,
  params: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    category?: string;
    source?: "manual" | "auto-recall" | "cli";
  },
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(params);
  if (results.length === 0) {
    await sleep(75);
    results = await retriever.retrieve(params);
  }
  return results;
}

export async function resolveMemoryId(
  context: ToolContext,
  memoryRef: string,
  scopeFilter?: string[],
): Promise<
  | { ok: true; id: string }
  | { ok: false; message: string; details?: Record<string, unknown> }
> {
  const trimmed = memoryRef.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "memoryId/query 不能为空。",
      details: { error: "empty_memory_ref" },
    };
  }

  const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(trimmed);
  if (uuidLike) {
    return { ok: true, id: trimmed };
  }

  const results = await retrieveWithRetry(context.retriever, {
    query: trimmed,
    limit: 5,
    scopeFilter,
  });
  if (results.length === 0) {
    return {
      ok: false,
      message: `No memory found matching "${normalizeInlineText(trimmed)}".`,
      details: { error: "not_found", query: normalizeInlineText(trimmed) },
    };
  }
  if (results.length === 1 || results[0].score > 0.85) {
    return { ok: true, id: results[0].entry.id };
  }

  const list = results
    .map(
      (r) =>
        `- [${r.entry.id.slice(0, 8)}] ${truncateText(normalizeInlineText(r.entry.text), 60)}`,
    )
    .join("\n");
  return {
    ok: false,
    message: `Multiple matches. Specify memoryId:\n${list}`,
    details: {
      action: "candidates",
      candidates: sanitizeMemoryForSerialization(results),
    },
  };
}

export function resolveWorkspaceDir(toolCtx: unknown, fallback?: string): string {
  const runtime = toolCtx as Record<string, unknown> | undefined;
  const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
  if (runtimePath) return runtimePath;
  if (fallback && fallback.trim()) return fallback;
  return join(homedir(), ".openclaw", "workspace");
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
