/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { redactMemoryTextForOutput } from "./memory-egress-policy.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import { filterUserMdExclusiveRecallResults } from "./workspace-boundary.js";
import { clampInt, MEMORY_CATEGORIES, normalizeInlineText, requireRuntimeAgentId, requireRuntimeMemoryAccess, resolveToolContext, retrieveWithRetry, safeToolFailure, sanitizeMemoryForSerialization, stringEnum, truncateText } from "./tool-runtime-policy.js";
export function registerMemoryRecallTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_recall",
            label: "Memory Recall",
            description: "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
            parameters: Type.Object({
                query: Type.String({
                    description: "Search query for finding relevant memories",
                }),
                limit: Type.Optional(Type.Number({
                    description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
                })),
                includeFullText: Type.Optional(Type.Boolean({
                    description: "Return full memory text when true (default: false returns summary previews)",
                })),
                maxCharsPerItem: Type.Optional(Type.Number({
                    description: "Maximum characters per returned memory in summary mode (default: 180)",
                })),
                scope: Type.Optional(Type.String({
                    description: "Specific memory scope to search in (optional)",
                })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 3, includeFullText = false, maxCharsPerItem = 180, scope, category, } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_recall");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_recall");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    const access = accessResolution.access;
                    const safeLimit = includeFullText
                        ? clampInt(limit, 1, 20)
                        : clampInt(limit, 1, 6);
                    const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);
                    // Determine accessible scopes
                    let scopeFilter = access.scopeFilter;
                    if (scope) {
                        if (access.isAccessible(scope)) {
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
                    const results = filterUserMdExclusiveRecallResults(await retrieveWithRetry(runtimeContext.retriever, {
                        query,
                        limit: safeLimit,
                        scopeFilter,
                        category,
                        source: "manual",
                    }), runtimeContext.workspaceBoundary);
                    if (results.length === 0) {
                        return {
                            content: [{ type: "text", text: "No relevant memories found." }],
                            details: { count: 0, query: redactMemoryTextForOutput(query), scopes: scopeFilter },
                        };
                    }
                    const now = Date.now();
                    await Promise.allSettled(results.map((result) => {
                        const meta = parseSmartMetadata(result.entry.metadata, result.entry);
                        return runtimeContext.store.patchMetadata(result.entry.id, {
                            access_count: meta.access_count + 1,
                            last_accessed_at: now,
                            last_confirmed_use_at: now,
                            bad_recall_count: 0,
                            suppressed_until_turn: 0,
                        }, scopeFilter);
                    }));
                    const text = results
                        .map((r, i) => {
                        const categoryTag = getDisplayCategoryTag(r.entry);
                        const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
                        const base = includeFullText
                            ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
                            : (metadata.l0_abstract || r.entry.text);
                        const inline = normalizeInlineText(base);
                        const rendered = includeFullText
                            ? inline
                            : truncateText(inline, safeCharsPerItem);
                        return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${rendered}`;
                    })
                        .join("\n");
                    const serializedMemories = sanitizeMemoryForSerialization(results);
                    if (includeFullText) {
                        for (let i = 0; i < results.length; i++) {
                            const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
                            serializedMemories[i].fullText =
                                redactMemoryTextForOutput(metadata.l2_content || metadata.l1_overview || results[i].entry.text);
                        }
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${results.length} memories:\n\n${text}`,
                            },
                        ],
                        details: {
                            count: results.length,
                            memories: serializedMemories,
                            query: redactMemoryTextForOutput(query),
                            scopes: scopeFilter,
                            retrievalMode: runtimeContext.retriever.getConfig().mode,
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("recall_failed", "Memory recall failed", error);
                }
            },
        };
    }, { name: "memory_recall" });
}
