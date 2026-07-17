/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { resolveRuntimeMemoryAccess } from "./runtime-memory-boundary.js";
import { parseAgentIdFromSessionKey } from "./scopes.js";
import { parseSmartMetadata } from "./smart-metadata.js";
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
];
export function stringEnum(values) {
    return Type.Unsafe({
        type: "string",
        enum: [...values],
    });
}
// ============================================================================
// Utility Functions
// ============================================================================
export function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
export function clamp01(value, fallback = 0.7) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(1, Math.max(0, value));
}
export function safeToolFailure(code, label, error) {
    console.warn(`clawlore: tool ${code}: ${diagnosticErrorSummary(error)}`);
    return {
        content: [{ type: "text", text: `${label}. Reference: ${code}` }],
        details: { error: code },
        isError: true,
    };
}
export function normalizeInlineText(text) {
    return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
export function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
    return `${clipped}…`;
}
export function deriveManualMemoryLayer(category) {
    if (category === "preference" || category === "decision" || category === "fact") {
        return "durable";
    }
    return "working";
}
export function sanitizeMemoryForSerialization(results) {
    return results.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        category: getDisplayCategoryTag(r.entry),
        rawCategory: r.entry.category,
        scope: r.entry.scope,
        importance: r.entry.importance,
        score: r.score,
        sources: r.sources,
    }));
}
export function serializeMemoryEntry(entry, includeFullText = false) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    const base = {
        id: entry.id,
        text: includeFullText
            ? metadata.l2_content || metadata.l1_overview || entry.text
            : truncateText(normalizeInlineText(metadata.l0_abstract || entry.text), 220),
        category: getDisplayCategoryTag(entry),
        rawCategory: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: entry.timestamp,
        state: metadata.state,
        layer: metadata.memory_layer,
        source: metadata.source,
        tier: metadata.tier,
        confidence: metadata.confidence,
        factKey: metadata.fact_key,
        validFrom: metadata.valid_from,
        invalidatedAt: metadata.invalidated_at,
        supersedes: metadata.supersedes,
        supersededBy: metadata.superseded_by,
        canonicalId: metadata.canonical_id,
        relations: metadata.relations ?? [],
    };
    return includeFullText
        ? {
            ...base,
            l0Abstract: metadata.l0_abstract,
            l1Overview: metadata.l1_overview,
            l2Content: metadata.l2_content,
        }
        : base;
}
export function renderMemoryEntry(entry, index, includeFullText = false) {
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
    return `${prefix}[${entry.id}] [${categoryTag}:${entry.scope}] ${text} (${date}; ${sourceBits})`;
}
export function memoryMetadataMatches(entry, filters) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    if (filters.source && metadata.source !== filters.source)
        return false;
    if (filters.state && metadata.state !== filters.state)
        return false;
    if (filters.layer && metadata.memory_layer !== filters.layer)
        return false;
    return true;
}
const _warnedMissingAgentId = new Set();
/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState() {
    _warnedMissingAgentId.clear();
}
export function resolveRuntimeAgentId(staticAgentId, runtimeCtx) {
    if (!runtimeCtx || typeof runtimeCtx !== "object") {
        const fallback = staticAgentId?.trim();
        if (!fallback && !_warnedMissingAgentId.has("no-context")) {
            _warnedMissingAgentId.add("no-context");
            console.warn("resolveRuntimeAgentId: no runtime context or static agentId; refusing implicit agent:main scope.");
        }
        return fallback || undefined;
    }
    const ctx = runtimeCtx;
    const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
    const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
    const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
    const trimmed = resolved?.trim();
    if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
        _warnedMissingAgentId.add("empty-resolved");
        console.warn("resolveRuntimeAgentId: resolved agentId is empty after trim; refusing implicit agent:main scope.");
    }
    return trimmed ? trimmed : undefined;
}
export function resolveToolContext(base, runtimeCtx) {
    return {
        ...base,
        agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx),
    };
}
export function missingAgentContextResponse(toolName) {
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
export function requireRuntimeAgentId(staticAgentId, runtimeCtx, toolName) {
    const agentId = resolveRuntimeAgentId(staticAgentId, runtimeCtx);
    if (agentId)
        return { ok: true, agentId };
    return { ok: false, response: missingAgentContextResponse(toolName) };
}
export function deniedMemoryBoundaryResponse(toolName, access) {
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
export function requireRuntimeMemoryAccess(context, agentId, staticContext, runtimeContext, toolName) {
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
export async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}
export async function retrieveWithRetry(retriever, params) {
    let results = await retriever.retrieve(params);
    if (results.length === 0) {
        await sleep(75);
        results = await retriever.retrieve(params);
    }
    return results;
}
export async function resolveMemoryId(context, memoryRef, scopeFilter) {
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
            message: `No memory found matching "${trimmed}".`,
            details: { error: "not_found", query: trimmed },
        };
    }
    if (results.length === 1 || results[0].score > 0.85) {
        return { ok: true, id: results[0].entry.id };
    }
    const list = results
        .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`)
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
export function resolveWorkspaceDir(toolCtx, fallback) {
    const runtime = toolCtx;
    const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
    if (runtimePath)
        return runtimePath;
    if (fallback && fallback.trim())
        return fallback;
    return join(homedir(), ".openclaw", "workspace");
}
export function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
