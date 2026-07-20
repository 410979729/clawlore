/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./memory-categories.js";
import { isNoise } from "./noise-filter.js";
import { appendRelation, buildSmartMetadata, deriveFactKey, parseSmartMetadata, stringifySmartMetadata, } from "./smart-metadata.js";
import { clamp01, MEMORY_CATEGORIES, normalizeInlineText, requireRuntimeAgentId, requireRuntimeMemoryAccess, resolveToolContext, retrieveWithRetry, safeToolFailure, sanitizeMemoryForSerialization, stringEnum, truncateText } from "./tool-runtime-policy.js";
export function registerMemoryForgetTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_forget",
            label: "Memory Forget",
            description: "Preview and delete specific memories. Deletion requires confirm=true.",
            parameters: Type.Object({
                query: Type.Optional(Type.String({ description: "Search query to find memory to delete" })),
                memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
                scope: Type.Optional(Type.String({
                    description: "Scope to search/delete from (optional)",
                })),
                confirm: Type.Optional(Type.Boolean({
                    description: "Required true to delete a memoryId. Query mode returns candidates for confirmation.",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, memoryId, scope, confirm } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_forget");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_forget");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    const access = accessResolution.access;
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
                    if (memoryId) {
                        if (confirm !== true) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Deletion requires confirm=true for memoryId ${memoryId}.`,
                                    },
                                ],
                                details: {
                                    action: "confirmation_required",
                                    id: memoryId,
                                },
                            };
                        }
                        const deleted = await context.store.delete(memoryId, scopeFilter);
                        if (deleted) {
                            return {
                                content: [
                                    { type: "text", text: `Memory ${memoryId} forgotten.` },
                                ],
                                details: { action: "deleted", id: memoryId },
                            };
                        }
                        else {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Memory ${memoryId} not found or access denied.`,
                                    },
                                ],
                                details: { error: "not_found", id: memoryId },
                            };
                        }
                    }
                    if (query) {
                        const results = await retrieveWithRetry(context.retriever, {
                            query,
                            limit: 5,
                            scopeFilter,
                        });
                        if (results.length === 0) {
                            return {
                                content: [
                                    { type: "text", text: "No matching memories found." },
                                ],
                                details: { found: 0, query: normalizeInlineText(query) },
                            };
                        }
                        const list = results
                            .map((r) => `- [${r.entry.id.slice(0, 8)}] ${truncateText(normalizeInlineText(r.entry.text), 60)}`)
                            .join("\n");
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                                },
                            ],
                            details: {
                                action: "candidates",
                                candidates: sanitizeMemoryForSerialization(results),
                            },
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Provide either 'query' to search for memories or 'memoryId' to delete specific memory.",
                            },
                        ],
                        details: { error: "missing_param" },
                    };
                }
                catch (error) {
                    return safeToolFailure("delete_failed", "Memory deletion failed", error);
                }
            },
        };
    }, { name: "memory_forget" });
}
// ============================================================================
// Update Tool
// ============================================================================
export function registerMemoryUpdateTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_update",
            label: "Memory Update",
            description: "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history. Metadata-only changes (importance, category) update in-place.",
            parameters: Type.Object({
                memoryId: Type.String({
                    description: "ID of the memory to update (full UUID or 8+ char prefix)",
                }),
                text: Type.Optional(Type.String({
                    description: "New text content (triggers re-embedding)",
                })),
                importance: Type.Optional(Type.Number({ description: "New importance score 0-1" })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, text, importance, category } = params;
                try {
                    if (!text && importance === undefined && !category) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Nothing to update. Provide at least one of: text, importance, category.",
                                },
                            ],
                            details: { error: "no_updates" },
                        };
                    }
                    // Determine accessible scopes
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_update");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const accessResolution = requireRuntimeMemoryAccess(runtimeContext, agentId, toolCtx, runtimeCtx, "memory_update");
                    if (accessResolution.ok === false)
                        return accessResolution.response;
                    const scopeFilter = accessResolution.access.scopeFilter;
                    // Resolve memoryId: if it doesn't look like a UUID, try search
                    let resolvedId = memoryId;
                    const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
                    if (!uuidLike) {
                        // Treat as search query
                        const results = await retrieveWithRetry(context.retriever, {
                            query: memoryId,
                            limit: 3,
                            scopeFilter,
                        });
                        if (results.length === 0) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `No memory found matching "${memoryId}".`,
                                    },
                                ],
                                details: { error: "not_found", query: normalizeInlineText(memoryId) },
                            };
                        }
                        if (results.length === 1 || results[0].score > 0.85) {
                            resolvedId = results[0].entry.id;
                        }
                        else {
                            const list = results
                                .map((r) => `- [${r.entry.id.slice(0, 8)}] ${truncateText(normalizeInlineText(r.entry.text), 60)}`)
                                .join("\n");
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Multiple matches. Specify memoryId:\n${list}`,
                                    },
                                ],
                                details: {
                                    action: "candidates",
                                    candidates: sanitizeMemoryForSerialization(results),
                                },
                            };
                        }
                    }
                    // If text changed, re-embed; reject noise
                    let updatedText = text;
                    let newVector;
                    if (text) {
                        const captureSafety = evaluateCaptureSafety(text);
                        if (!captureSafety.allowed) {
                            return {
                                content: [{
                                        type: "text",
                                        text: `Skipped: updated text blocked by capture safety filter (${captureSafety.reason})`,
                                    }],
                                details: {
                                    action: "capture_safety_filtered",
                                    reason: captureSafety.reason,
                                    pattern: captureSafety.pattern,
                                },
                            };
                        }
                        updatedText = sanitizeCaptureText(text) || text;
                        if (isNoise(updatedText)) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "Skipped: updated text detected as noise",
                                    },
                                ],
                                details: { action: "noise_filtered" },
                            };
                        }
                        newVector = await context.embedder.embedPassage(updatedText);
                    }
                    // --- Temporal supersede guard ---
                    // For temporal-versioned categories (preferences/entities), changing
                    // text must go through supersede to preserve the history chain.
                    if (updatedText && newVector) {
                        const existing = await context.store.getById(resolvedId, scopeFilter);
                        if (existing) {
                            const meta = parseSmartMetadata(existing.metadata, existing);
                            if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
                                const factKey = meta.fact_key ?? deriveFactKey(meta.memory_category, updatedText) ?? existing.id;
                                const newEntry = await context.store.supersede(resolvedId, {
                                    text: updatedText,
                                    vector: newVector,
                                    category: category ? category : existing.category,
                                    importance: importance !== undefined
                                        ? clamp01(importance, 0.7)
                                        : existing.importance,
                                    buildMetadata: ({ oldEntry, newId, now }) => {
                                        const currentMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
                                        const newMeta = buildSmartMetadata({ text: updatedText, category: existing.category }, {
                                            l0_abstract: updatedText,
                                            l1_overview: currentMeta.l1_overview,
                                            l2_content: updatedText,
                                            memory_category: currentMeta.memory_category,
                                            tier: currentMeta.tier,
                                            access_count: 0,
                                            confidence: importance !== undefined ? clamp01(importance, 0.7) : currentMeta.confidence,
                                            valid_from: now,
                                            fact_key: factKey,
                                            supersedes: oldEntry.id,
                                            relations: appendRelation([], {
                                                type: "supersedes",
                                                targetId: oldEntry.id,
                                            }),
                                        });
                                        const invalidatedMeta = buildSmartMetadata(oldEntry, {
                                            fact_key: factKey,
                                            invalidated_at: now,
                                            superseded_by: newId,
                                            relations: appendRelation(currentMeta.relations, {
                                                type: "superseded_by",
                                                targetId: newId,
                                            }),
                                        });
                                        return {
                                            factKey,
                                            newMetadata: stringifySmartMetadata(newMeta),
                                            oldMetadata: stringifySmartMetadata(invalidatedMeta),
                                        };
                                    },
                                }, scopeFilter);
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${truncateText(normalizeInlineText(updatedText), 80)}"`,
                                        },
                                    ],
                                    details: {
                                        action: "superseded",
                                        oldId: resolvedId,
                                        newId: newEntry.id,
                                        category: meta.memory_category,
                                    },
                                };
                            }
                        }
                    }
                    // --- End temporal supersede guard ---
                    const updates = {};
                    if (updatedText)
                        updates.text = updatedText;
                    if (newVector)
                        updates.vector = newVector;
                    if (importance !== undefined)
                        updates.importance = clamp01(importance, 0.7);
                    if (category)
                        updates.category = category;
                    const updated = await context.store.update(resolvedId, updates, scopeFilter);
                    if (!updated) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                                },
                            ],
                            details: { error: "not_found", id: resolvedId },
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Updated memory ${updated.id.slice(0, 8)}...: "${truncateText(normalizeInlineText(updated.text), 80)}"`,
                            },
                        ],
                        details: {
                            action: "updated",
                            id: updated.id,
                            scope: updated.scope,
                            category: updated.category,
                            importance: updated.importance,
                            fieldsUpdated: Object.keys(updates),
                        },
                    };
                }
                catch (error) {
                    return safeToolFailure("update_failed", "Memory update failed", error);
                }
            },
        };
    }, { name: "memory_update" });
}
// ============================================================================
// Management Tools (Optional)
// ============================================================================
