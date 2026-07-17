/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { buildGovernanceReviewCandidates } from "./conflict-governance.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import { clampInt, normalizeInlineText, requireRuntimeAgentId, requireRuntimeMemoryAccess, resolveMemoryId, resolveToolContext, retrieveWithRetry, sanitizeMemoryForSerialization, truncateText } from "./tool-runtime-policy.js";
export function registerMemoryGovernTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_govern",
            label: "Memory Governance Review",
            description: "List memories that need operator review: conflicts, archived/inactive lifecycle rows, local scratch, legacy rows, and low-confidence auto-captures.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional accessible scope filter." })),
                limit: Type.Optional(Type.Number({ description: "Max candidates to return (default: 20, max: 100)." })),
                includeText: Type.Optional(Type.Boolean({ description: "Include full memory text in details." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope, limit = 20, includeText = false } = params;
                const safeLimit = clampInt(limit, 1, 100);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_govern");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_govern");
                if (accessResolution.ok === false)
                    return accessResolution.response;
                let scopeFilter = accessResolution.access.scopeFilter;
                if (scope) {
                    if (!accessResolution.access.isAccessible(scope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const entries = await context.store.list(scopeFilter, undefined, 1000, 0);
                const candidates = buildGovernanceReviewCandidates(entries, {
                    limit: safeLimit,
                    includeText,
                });
                if (candidates.length === 0) {
                    return {
                        content: [{ type: "text", text: "No memory governance candidates found." }],
                        details: { count: 0, scopes: scopeFilter },
                    };
                }
                const lines = candidates.map((candidate, index) => {
                    const reasons = candidate.reasons.join(",");
                    return `${index + 1}. [${candidate.id}] [${candidate.category}:${candidate.scope}] ${truncateText(normalizeInlineText(candidate.text), 140)} (${reasons}; action=${candidate.suggestedAction})`;
                });
                return {
                    content: [{ type: "text", text: `Memory governance candidates (${candidates.length}):\n\n${lines.join("\n")}` }],
                    details: {
                        count: candidates.length,
                        candidates,
                        scopes: scopeFilter,
                    },
                };
            },
        };
    }, { name: "memory_govern" });
}
export function registerMemoryPromoteTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_promote",
            label: "Memory Promote",
            description: "Set a memory governance state/layer, including confirmed promotion or archive/rejected review outcomes.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix). Optional when query is provided." })),
                query: Type.Optional(Type.String({ description: "Search query to locate a memory when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                state: Type.Optional(Type.Union([
                    Type.Literal("pending"),
                    Type.Literal("confirmed"),
                    Type.Literal("archived"),
                    Type.Literal("rejected"),
                ])),
                layer: Type.Optional(Type.Union([
                    Type.Literal("durable"),
                    Type.Literal("working"),
                    Type.Literal("reflection"),
                    Type.Literal("archive"),
                ])),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, state = "confirmed", layer, } = params;
                const targetLayer = layer ?? (state === "archived" || state === "rejected" ? "archive" : "durable");
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_promote");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_promote");
                if (accessResolution.ok === false)
                    return accessResolution.response;
                let scopeFilter = accessResolution.access.scopeFilter;
                if (!scope && scopeFilter === undefined) {
                    return {
                        content: [{ type: "text", text: "System bypass callers must provide an explicit write scope." }],
                        details: { error: "explicit_scope_required" },
                    };
                }
                if (scope) {
                    if (!accessResolution.access.isAccessible(scope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                if (resolved.ok === false) {
                    return {
                        content: [{ type: "text", text: resolved.message }],
                        details: resolved.details ?? { error: "resolve_failed" },
                    };
                }
                const before = await runtimeContext.store.getById(resolved.id, scopeFilter);
                if (!before) {
                    return {
                        content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
                        details: { error: "not_found", id: resolved.id },
                    };
                }
                const now = Date.now();
                const updated = await runtimeContext.store.patchMetadata(resolved.id, {
                    source: "manual",
                    state,
                    memory_layer: targetLayer,
                    last_confirmed_use_at: state === "confirmed" ? now : undefined,
                    bad_recall_count: 0,
                    suppressed_until_turn: 0,
                }, scopeFilter);
                if (!updated) {
                    return {
                        content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
                        details: { error: "promote_failed", id: resolved.id },
                    };
                }
                return {
                    content: [{
                            type: "text",
                            text: `Updated memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${targetLayer}.`,
                        }],
                    details: {
                        action: "state_updated",
                        id: resolved.id,
                        state,
                        layer: targetLayer,
                    },
                };
            },
        };
    }, { name: "memory_promote" });
}
export function registerMemoryArchiveTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_archive",
            label: "Memory Archive",
            description: "Archive a memory to remove it from default auto-recall while preserving history.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
                query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                reason: Type.Optional(Type.String({ description: "Archive reason for audit trail." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, reason = "manual_archive" } = params;
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_archive");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_archive");
                if (accessResolution.ok === false)
                    return accessResolution.response;
                let scopeFilter = accessResolution.access.scopeFilter;
                if (!scope && scopeFilter === undefined) {
                    return {
                        content: [{ type: "text", text: "System bypass callers must provide an explicit write scope." }],
                        details: { error: "explicit_scope_required" },
                    };
                }
                if (scope) {
                    if (!accessResolution.access.isAccessible(scope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                if (resolved.ok === false) {
                    return {
                        content: [{ type: "text", text: resolved.message }],
                        details: resolved.details ?? { error: "resolve_failed" },
                    };
                }
                const patch = {
                    state: "archived",
                    memory_layer: "archive",
                    archive_reason: reason,
                    archived_at: Date.now(),
                };
                const updated = await runtimeContext.store.patchMetadata(resolved.id, patch, scopeFilter);
                if (!updated) {
                    return {
                        content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
                        details: { error: "archive_failed", id: resolved.id },
                    };
                }
                return {
                    content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
                    details: { action: "archived", id: resolved.id, reason },
                };
            },
        };
    }, { name: "memory_archive" });
}
export function registerMemoryCompactTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_compact",
            label: "Memory Compact",
            description: "Compact duplicate low-value memories by archiving redundant entries and linking them to a canonical memory.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only (default true)." })),
                limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200)." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope, dryRun = true, limit = 200 } = params;
                const safeLimit = clampInt(limit, 20, 1000);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_compact");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_compact");
                if (accessResolution.ok === false)
                    return accessResolution.response;
                let scopeFilter = accessResolution.access.scopeFilter;
                if (scope) {
                    if (!accessResolution.access.isAccessible(scope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const entries = await runtimeContext.store.list(scopeFilter, undefined, safeLimit, 0);
                const canonicalByKey = new Map();
                const duplicates = [];
                for (const entry of entries) {
                    const meta = parseSmartMetadata(entry.metadata, entry);
                    if (meta.state === "archived")
                        continue;
                    const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
                    const existing = canonicalByKey.get(key);
                    if (!existing) {
                        canonicalByKey.set(key, entry);
                        continue;
                    }
                    const keep = existing.timestamp >= entry.timestamp ? existing : entry;
                    const drop = keep.id === existing.id ? entry : existing;
                    canonicalByKey.set(key, keep);
                    duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
                }
                let archivedCount = 0;
                if (!dryRun) {
                    for (const item of duplicates) {
                        await runtimeContext.store.patchMetadata(item.duplicateId, {
                            state: "archived",
                            memory_layer: "archive",
                            canonical_id: item.canonicalId,
                            archive_reason: "compact_duplicate",
                            archived_at: Date.now(),
                        }, scopeFilter);
                        archivedCount++;
                    }
                }
                return {
                    content: [{
                            type: "text",
                            text: dryRun
                                ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
                                : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
                        }],
                    details: {
                        action: dryRun ? "compact_preview" : "compact_applied",
                        scanned: entries.length,
                        duplicates: duplicates.length,
                        archived: archivedCount,
                        sample: duplicates.slice(0, 20),
                    },
                };
            },
        };
    }, { name: "memory_compact" });
}
export function registerMemoryExplainRankTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_explain_rank",
            label: "Memory Explain Rank",
            description: "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
            parameters: Type.Object({
                query: Type.String({ description: "Query used for ranking analysis." }),
                limit: Type.Optional(Type.Number({ description: "How many items to explain (default 5)." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 5, scope } = params;
                const safeLimit = clampInt(limit, 1, 20);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_explain_rank");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_explain_rank");
                if (accessResolution.ok === false)
                    return accessResolution.response;
                let scopeFilter = accessResolution.access.scopeFilter;
                if (scope) {
                    if (!accessResolution.access.isAccessible(scope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const results = await retrieveWithRetry(runtimeContext.retriever, {
                    query,
                    limit: safeLimit,
                    scopeFilter,
                    source: "manual",
                });
                if (results.length === 0) {
                    return {
                        content: [{ type: "text", text: "No relevant memories found." }],
                        details: { action: "empty", query, scopeFilter },
                    };
                }
                const lines = results.map((r, idx) => {
                    const meta = parseSmartMetadata(r.entry.metadata, r.entry);
                    const sourceBreakdown = [];
                    if (r.sources.vector)
                        sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
                    if (r.sources.bm25)
                        sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
                    if (r.sources.reranked)
                        sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
                    return [
                        `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
                        `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
                        `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
                        `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
                    ].join("\n");
                });
                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: {
                        action: "explain_rank",
                        query,
                        count: results.length,
                        results: sanitizeMemoryForSerialization(results),
                    },
                };
            },
        };
    }, { name: "memory_explain_rank" });
}
// ============================================================================
// Tool Registration Helper
// ============================================================================
