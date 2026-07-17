/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */
import { Type } from "@sinclair/typebox";
import { ExperienceValidationError } from "./experience-models.js";
import { createPlaybook, ensureExperienceSchema, getEpisode, getPlaybook, getPlaybookVersions, listRunsForPlaybook, recordPlaybookFeedbackAtomically, searchPlaybooks } from "./experience-store.js";
import { CAPABILITY_CLASS_VALUES, PLAYBOOK_STATUS_VALUES, resolveExperienceRuntime, safeExperienceToolFailure, stringEnum } from "./experience-tool-runtime-policy.js";
export function registerPlaybookSearchTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_playbook_search",
            label: "Search Playbooks",
            description: "Search for reusable procedural playbooks by query, task class, or status. Returns matching playbooks with their steps, pitfalls, and verification methods. Use this before starting a task to find relevant experience.",
            parameters: Type.Object({
                query: Type.Optional(Type.String({ description: "Search query to match against playbook title, trigger, goal, and steps" })),
                task_class: Type.Optional(Type.String({ description: "Filter by exact task class" })),
                status: Type.Optional(stringEnum(PLAYBOOK_STATUS_VALUES)),
                limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 20)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, task_class, status, limit } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_search");
                    if (runtime.ok === false)
                        return runtime.response;
                    const db = await context.db();
                    if (!db) {
                        return {
                            content: [{ type: "text", text: "Error: SQL truth store not available" }],
                            isError: true,
                        };
                    }
                    ensureExperienceSchema(db);
                    const playbooks = searchPlaybooks(db, {
                        query,
                        scope_ids: runtime.scopeFilter,
                        task_class,
                        status,
                        limit: limit || 20,
                    });
                    if (playbooks.length === 0) {
                        return {
                            content: [{ type: "text", text: "No matching playbooks found." }],
                            details: { count: 0 },
                        };
                    }
                    const formatted = playbooks.map((p) => ({
                        id: p.id,
                        task_class: p.task_class,
                        title: p.title,
                        status: p.status,
                        confidence: p.confidence,
                        steps_count: p.steps.length,
                        score: p.score,
                    }));
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${playbooks.length} playbook(s):\n\n${JSON.stringify(formatted, null, 2)}`,
                            },
                        ],
                        details: { count: playbooks.length, playbooks: formatted },
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("playbook_search_failed", "Error searching playbooks", error);
                }
            },
        };
    });
}
export function registerPlaybookInspectTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_playbook_inspect",
            label: "Inspect Playbook",
            description: "Inspect a specific procedural playbook by ID. Returns the full playbook including all steps, pitfalls, verification methods, and recent run history.",
            parameters: Type.Object({
                playbook_id: Type.String({ description: "The ID of the playbook to inspect" }),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { playbook_id } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_inspect");
                    if (runtime.ok === false)
                        return runtime.response;
                    const db = await context.db();
                    if (!db) {
                        return {
                            content: [{ type: "text", text: "Error: SQL truth store not available" }],
                            isError: true,
                        };
                    }
                    ensureExperienceSchema(db);
                    const playbook = getPlaybook(db, playbook_id, runtime.scopeFilter);
                    if (!playbook) {
                        return {
                            content: [{ type: "text", text: `Playbook not found: ${playbook_id}` }],
                            isError: true,
                        };
                    }
                    const versions = getPlaybookVersions(db, playbook_id, runtime.scopeFilter);
                    const recentRuns = listRunsForPlaybook(db, playbook_id, 5, runtime.scopeFilter);
                    const result = {
                        ...playbook,
                        versions_count: versions.length,
                        recent_runs: recentRuns.map((r) => ({
                            id: r.id,
                            outcome: r.outcome,
                            started_at: r.started_at,
                        })),
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("playbook_inspect_failed", "Error inspecting playbook", error);
                }
            },
        };
    });
}
export function registerPlaybookCreateTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_playbook_create",
            label: "Create Playbook",
            description: "Create a new procedural playbook from a successful task episode. The playbook must follow the procedural_playbook.v1 schema with ordered steps, capability classes, and verification requirements. New playbooks start with status 'candidate'.",
            parameters: Type.Object({
                task_class: Type.String({ description: "Task classification" }),
                title: Type.String({ description: "Short descriptive title" }),
                trigger: Type.String({ description: "When should this playbook be used?" }),
                goal: Type.String({ description: "What is the goal of following this playbook?" }),
                preconditions: Type.Array(Type.Object({}, { additionalProperties: true }), {
                    description: "List of preconditions",
                }),
                steps: Type.Array(Type.Object({
                    number: Type.Number(),
                    capability_class: stringEnum(CAPABILITY_CLASS_VALUES),
                    action: Type.String(),
                    evidence_required: Type.String(),
                    why: Type.Optional(Type.String()),
                    previous_mistakes: Type.Optional(Type.Array(Type.String())),
                }), { description: "Ordered steps with capability classification" }),
                pitfalls: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), {
                    description: "Known pitfalls",
                })),
                verification: Type.Array(Type.String(), {
                    description: "How to verify task completion",
                }),
                cleanup: Type.Optional(Type.Array(Type.String(), { description: "Cleanup steps" })),
                episode_id: Type.Optional(Type.String({ description: "Episode this playbook was derived from" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { task_class, title, trigger, goal, preconditions, steps, pitfalls, verification, cleanup, episode_id, } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_create");
                    if (runtime.ok === false)
                        return runtime.response;
                    const db = await context.db();
                    if (!db) {
                        return {
                            content: [{ type: "text", text: "Error: SQL truth store not available" }],
                            isError: true,
                        };
                    }
                    ensureExperienceSchema(db);
                    if (episode_id && !getEpisode(db, episode_id, runtime.scopeFilter)) {
                        return {
                            content: [{ type: "text", text: "Error: source episode is outside the current memory boundary" }],
                            isError: true,
                        };
                    }
                    const playbook = createPlaybook(db, {
                        scope_id: runtime.defaultScope,
                        payload: {
                            schema_version: "procedural_playbook.v1",
                            task_class,
                            title,
                            trigger,
                            goal,
                            preconditions,
                            steps,
                            pitfalls: pitfalls || [],
                            verification,
                            cleanup: cleanup || [],
                            status: "candidate",
                            confidence: 0.5,
                            reuse_policy: {},
                        },
                        created_from_episode_id: episode_id || "",
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Playbook created: ${playbook.id}\nTitle: ${playbook.title}\nStatus: ${playbook.status}\nSteps: ${playbook.steps.length}`,
                            },
                        ],
                        details: { playbook_id: playbook.id, status: playbook.status },
                    };
                }
                catch (error) {
                    if (error instanceof ExperienceValidationError) {
                        return safeExperienceToolFailure("playbook_validation_failed", "Playbook validation failed", error);
                    }
                    return safeExperienceToolFailure("playbook_create_failed", "Error creating playbook", error);
                }
            },
        };
    });
}
export function registerPlaybookFeedbackTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_playbook_feedback",
            label: "Playbook Feedback",
            description: "Record feedback about a playbook after using it. Tracks success/failure to update playbook confidence and usage statistics.",
            parameters: Type.Object({
                playbook_id: Type.String({ description: "The ID of the playbook being reviewed" }),
                outcome: stringEnum(["success", "failure", "partial"]),
                outcome_reason: Type.Optional(Type.String({ description: "Brief explanation of the outcome" })),
                steps_completed: Type.Optional(Type.Array(Type.Number(), { description: "Which step numbers were completed" })),
                evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence collected during execution" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { playbook_id, outcome, outcome_reason, steps_completed, evidence } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_feedback");
                    if (runtime.ok === false)
                        return runtime.response;
                    const db = await context.db();
                    if (!db) {
                        return {
                            content: [{ type: "text", text: "Error: SQL truth store not available" }],
                            isError: true,
                        };
                    }
                    ensureExperienceSchema(db);
                    const playbook = getPlaybook(db, playbook_id, runtime.scopeFilter);
                    if (!playbook) {
                        return {
                            content: [{ type: "text", text: `Playbook not found: ${playbook_id}` }],
                            isError: true,
                        };
                    }
                    const run = recordPlaybookFeedbackAtomically(db, {
                        playbook_id,
                        scope_id: runtime.defaultScope,
                        decision: "used",
                        confidence_at_use: playbook.confidence,
                        steps_completed: steps_completed || [],
                        evidence: evidence || [],
                        outcome,
                        outcome_reason: outcome_reason || "",
                        counter: outcome === "partial" ? "stale" : outcome,
                        scope_ids: runtime.scopeFilter,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Feedback recorded for playbook ${playbook_id}\nOutcome: ${outcome}\nRun ID: ${run.id}`,
                            },
                        ],
                        details: { run_id: run.id, outcome },
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("playbook_feedback_failed", "Error recording feedback", error);
                }
            },
        };
    });
}
// ============================================================================
// Preflight Tool
// ============================================================================
