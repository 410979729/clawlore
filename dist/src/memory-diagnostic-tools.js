/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import { clampInt, MEMORY_CATEGORIES, memoryMetadataMatches, renderMemoryEntry, requireRuntimeAgentId, requireRuntimeMemoryAccess, resolveMemoryId, resolveToolContext, retrieveWithRetry, safeToolFailure, sanitizeMemoryForSerialization, serializeMemoryEntry, stringEnum } from "./tool-runtime-policy.js";
export function registerMemoryStatsTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_stats",
            label: "Memory Statistics",
            description: "Get statistics about memory usage, scopes, and categories.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({
                    description: "Specific scope to get stats for (optional)",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_stats");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_stats");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    // Determine accessible scopes
                    let scopeFilter = accessResolution.access.scopeFilter;
                    if (scope) {
                        if (accessResolution.access.isAccessible(scope)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    const stats = await context.store.stats(scopeFilter);
                    const scopeManagerStats = context.scopeManager.getStats();
                    const retrievalConfig = context.retriever.getConfig();
                    const textLines = [
                        `Memory Statistics:`,
                        `\u2022 Total memories: ${stats.totalCount}`,
                        `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
                        `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
                        `\u2022 FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
                        ``,
                        `Memories by scope:`,
                        ...Object.entries(stats.scopeCounts).map(([s, count]) => `  \u2022 ${s}: ${count}`),
                        ``,
                        `Memories by category:`,
                        ...Object.entries(stats.categoryCounts).map(([c, count]) => `  \u2022 ${c}: ${count}`),
                    ];
                    // Include retrieval quality metrics if stats collector is available
                    const statsCollector = context.retriever.getStatsCollector();
                    let retrievalStats;
                    if (statsCollector && statsCollector.count > 0) {
                        retrievalStats = statsCollector.getStats();
                        textLines.push(``, `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`, `  \u2022 Zero-result queries: ${retrievalStats.zeroResultQueries}`, `  \u2022 Avg latency: ${retrievalStats.avgLatencyMs}ms`, `  \u2022 P95 latency: ${retrievalStats.p95LatencyMs}ms`, `  \u2022 Avg result count: ${retrievalStats.avgResultCount}`, `  \u2022 Rerank used: ${retrievalStats.rerankUsed}`, `  \u2022 Noise filtered: ${retrievalStats.noiseFiltered}`);
                        if (retrievalStats.topDropStages.length > 0) {
                            textLines.push(`  Top drop stages:`);
                            for (const ds of retrievalStats.topDropStages) {
                                textLines.push(`    \u2022 ${ds.name}: ${ds.totalDropped} dropped`);
                            }
                        }
                    }
                    const text = textLines.join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: {
                            stats,
                            scopeManagerStats,
                            retrievalConfig: {
                                ...retrievalConfig,
                                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
                            },
                            hasFtsSupport: context.store.hasFtsSupport,
                            retrievalStats,
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("stats_failed", "Failed to get memory stats", error);
                }
            },
        };
    }, { name: "memory_stats" });
}
export function registerMemoryDebugTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_debug",
            label: "Memory Debug",
            description: "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
            parameters: Type.Object({
                query: Type.String({ description: "Search query to debug" }),
                limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5, max: 20)" })),
                scope: Type.Optional(Type.String({ description: "Specific memory scope to search in (optional)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 5, scope } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_debug");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_debug");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    const safeLimit = clampInt(limit, 1, 20);
                    let scopeFilter = accessResolution.access.scopeFilter;
                    if (scope) {
                        if (accessResolution.access.isAccessible(scope)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                                details: { error: "scope_access_denied", requestedScope: scope },
                            };
                        }
                    }
                    const { results, trace } = await context.retriever.retrieveWithTrace({
                        query, limit: safeLimit, scopeFilter, source: "manual",
                    });
                    const traceLines = [
                        `Retrieval Debug Trace:`,
                        `  Mode: ${trace.mode}`,
                        `  Total: ${trace.totalMs}ms`,
                        `  Stages:`,
                    ];
                    for (const stage of trace.stages) {
                        const dropped = Math.max(0, stage.inputCount - stage.outputCount);
                        const scoreStr = stage.scoreRange
                            ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
                            : "";
                        // For search stages (input=0), show "found N" instead of "dropped -N"
                        const dropStr = stage.inputCount === 0
                            ? `found ${stage.outputCount}`
                            : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
                        traceLines.push(`    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`);
                        if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
                            traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
                        }
                        else if (stage.droppedIds.length > 3) {
                            traceLines.push(`      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`);
                        }
                    }
                    if (results.length === 0) {
                        traceLines.push(``, `No results survived the pipeline.`);
                        return {
                            content: [{ type: "text", text: traceLines.join("\n") }],
                            details: { count: 0, query, trace },
                        };
                    }
                    const resultLines = results.map((r, i) => {
                        const sources = [];
                        if (r.sources.vector)
                            sources.push("vector");
                        if (r.sources.bm25)
                            sources.push("BM25");
                        if (r.sources.reranked)
                            sources.push("reranked");
                        const categoryTag = getDisplayCategoryTag(r.entry);
                        return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
                    });
                    const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: {
                            count: results.length,
                            memories: sanitizeMemoryForSerialization(results),
                            query,
                            trace,
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("debug_failed", "Memory debug failed", error);
                }
            },
        };
    }, { name: "memory_debug" });
}
export function registerMemoryListTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_list",
            label: "Memory List",
            description: "List recent memories with optional filtering by scope and category.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({
                    description: "Max memories to list (default: 10, max: 50)",
                })),
                scope: Type.Optional(Type.String({ description: "Filter by specific scope (optional)" })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
                offset: Type.Optional(Type.Number({
                    description: "Number of memories to skip (default: 0)",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { limit = 10, scope, category, offset = 0, } = params;
                try {
                    const safeLimit = clampInt(limit, 1, 50);
                    const safeOffset = clampInt(offset, 0, 1000);
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_list");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_list");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    // Determine accessible scopes
                    let scopeFilter = accessResolution.access.scopeFilter;
                    if (scope) {
                        if (accessResolution.access.isAccessible(scope)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    const entries = await context.store.list(scopeFilter, category, safeLimit, safeOffset);
                    if (entries.length === 0) {
                        return {
                            content: [{ type: "text", text: "No memories found." }],
                            details: {
                                count: 0,
                                filters: {
                                    scope,
                                    category,
                                    limit: safeLimit,
                                    offset: safeOffset,
                                },
                            },
                        };
                    }
                    const text = entries
                        .map((entry, i) => {
                        const date = new Date(entry.timestamp)
                            .toISOString()
                            .split("T")[0];
                        const categoryTag = getDisplayCategoryTag(entry);
                        return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
                    })
                        .join("\n");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Recent memories (showing ${entries.length}):\n\n${text}`,
                            },
                        ],
                        details: {
                            count: entries.length,
                            memories: entries.map((e) => ({
                                id: e.id,
                                text: e.text,
                                category: getDisplayCategoryTag(e),
                                rawCategory: e.category,
                                scope: e.scope,
                                importance: e.importance,
                                timestamp: e.timestamp,
                            })),
                            filters: {
                                scope,
                                category,
                                limit: safeLimit,
                                offset: safeOffset,
                            },
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("list_failed", "Failed to list memories", error);
                }
            },
        };
    }, { name: "memory_list" });
}
export function registerMemoryContextTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_context",
            label: "Memory Context",
            description: "Inspect the current accessible memory context with optional query, scope, category, source, state, and layer filters.",
            parameters: Type.Object({
                query: Type.Optional(Type.String({ description: "Optional query. When omitted, lists recent context." })),
                limit: Type.Optional(Type.Number({ description: "Max memories to return (default: 10, max: 30)" })),
                offset: Type.Optional(Type.Number({ description: "Number of recent memories to skip when query is omitted (default: 0)" })),
                scope: Type.Optional(Type.String({ description: "Filter by specific accessible scope." })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
                source: Type.Optional(Type.Union([
                    Type.Literal("manual"),
                    Type.Literal("auto-capture"),
                    Type.Literal("reflection"),
                    Type.Literal("session-summary"),
                    Type.Literal("legacy"),
                ])),
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
                includeFullText: Type.Optional(Type.Boolean({ description: "Return full memory text in details and rendered output." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 10, offset = 0, scope, category, source, state, layer, includeFullText = false, } = params;
                try {
                    const safeLimit = clampInt(limit, 1, 30);
                    const safeOffset = clampInt(offset, 0, 1000);
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_context");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_context");
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
                    const metadataFilters = { source, state, layer };
                    let entries;
                    if (query?.trim()) {
                        const candidateLimit = Math.min(80, Math.max(safeLimit * 4, safeLimit));
                        const results = await retrieveWithRetry(runtimeContext.retriever, {
                            query: query.trim(),
                            limit: candidateLimit,
                            scopeFilter,
                            category,
                        });
                        entries = results
                            .map((result) => result.entry)
                            .filter((entry) => memoryMetadataMatches(entry, metadataFilters))
                            .slice(0, safeLimit);
                    }
                    else {
                        const scanLimit = Math.min(500, Math.max(safeOffset + safeLimit * 5, safeLimit));
                        entries = (await runtimeContext.store.list(scopeFilter, category, scanLimit, 0))
                            .filter((entry) => memoryMetadataMatches(entry, metadataFilters))
                            .slice(safeOffset, safeOffset + safeLimit);
                    }
                    if (entries.length === 0) {
                        return {
                            content: [{ type: "text", text: "No memories matched the requested context filters." }],
                            details: {
                                action: "context",
                                count: 0,
                                query,
                                filters: { scope, category, source, state, layer, limit: safeLimit, offset: safeOffset },
                                scopes: scopeFilter,
                            },
                        };
                    }
                    const lines = entries.map((entry, index) => renderMemoryEntry(entry, index, includeFullText));
                    return {
                        content: [{
                                type: "text",
                                text: `Memory context (${entries.length}):\n\n${lines.join("\n")}`,
                            }],
                        details: {
                            action: "context",
                            count: entries.length,
                            query,
                            filters: { scope, category, source, state, layer, limit: safeLimit, offset: safeOffset },
                            scopes: scopeFilter,
                            memories: entries.map((entry) => serializeMemoryEntry(entry, includeFullText)),
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("context_failed", "Memory context inspection failed", error);
                }
            },
        };
    }, { name: "memory_context" });
}
export function registerMemoryInspectTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_inspect",
            label: "Memory Inspect",
            description: "Inspect one memory record by id/prefix or search query, including lifecycle metadata and relation hints.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id or unambiguous prefix." })),
                query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                includeFullText: Type.Optional(Type.Boolean({ description: "Return L0/L1/L2 content fields." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, includeFullText = true, } = params;
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_inspect");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_inspect");
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
                    const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                    if (resolved.ok === false) {
                        return {
                            content: [{ type: "text", text: resolved.message }],
                            details: resolved.details ?? { error: "resolve_failed" },
                        };
                    }
                    const entry = await runtimeContext.store.getById(resolved.id, scopeFilter);
                    if (!entry) {
                        return {
                            content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
                            details: { error: "not_found", id: resolved.id },
                        };
                    }
                    const metadata = parseSmartMetadata(entry.metadata, entry);
                    const lines = [
                        renderMemoryEntry(entry, undefined, includeFullText),
                        `state=${metadata.state} layer=${metadata.memory_layer} source=${metadata.source} tier=${metadata.tier} confidence=${metadata.confidence.toFixed(2)}`,
                        `access=${metadata.access_count} injected=${metadata.injected_count} badRecall=${metadata.bad_recall_count} suppressedUntilTurn=${metadata.suppressed_until_turn}`,
                    ];
                    if (metadata.fact_key)
                        lines.push(`factKey=${metadata.fact_key}`);
                    if (metadata.supersedes)
                        lines.push(`supersedes=${metadata.supersedes}`);
                    if (metadata.superseded_by)
                        lines.push(`supersededBy=${metadata.superseded_by}`);
                    if (metadata.canonical_id)
                        lines.push(`canonicalId=${metadata.canonical_id}`);
                    if (metadata.relations?.length) {
                        lines.push(`relations=${metadata.relations.map((rel) => `${rel.type}:${rel.targetId}`).join(", ")}`);
                    }
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                        details: {
                            action: "inspect",
                            memory: serializeMemoryEntry(entry, includeFullText),
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("inspect_failed", "Memory inspect failed", error);
                }
            },
        };
    }, { name: "memory_inspect" });
}
