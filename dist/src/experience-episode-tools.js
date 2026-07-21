/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */
import { Type } from "@sinclair/typebox";
import { createTaskEpisode, ensureExperienceSchema, getEpisode, updateEpisodeOutcome } from "./experience-store.js";
import { resolveExperienceRuntime, safeExperienceToolFailure, stringEnum } from "./experience-tool-runtime-policy.js";
export function registerEpisodeCreateTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_episode_create",
            label: "Create Task Episode",
            description: "Record the start of a task episode. Episodes track task execution for later playbook extraction. Call this at the start of a significant task.",
            parameters: Type.Object({
                task_goal: Type.String({ description: "What is the goal of this task?" }),
                task_class: Type.Optional(Type.String({ description: "Task classification (e.g., 'config_change', 'debugging', 'deployment')" })),
                user_intent: Type.Optional(Type.String({ description: "What the user asked for" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { task_goal, task_class, user_intent } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_episode_create");
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
                    const episode = createTaskEpisode(db, {
                        scope_id: runtime.defaultScope,
                        session_id: runtime.sessionId,
                        task_goal,
                        task_class: task_class || "",
                        user_intent: user_intent || "",
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Episode created: ${episode.id}\nStatus: ${episode.status}`,
                            },
                        ],
                        details: { episode_id: episode.id, status: episode.status },
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("episode_create_failed", "Error creating episode", error);
                }
            },
        };
    });
}
export function registerEpisodeCompleteTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_episode_complete",
            label: "Complete Task Episode",
            description: "Mark a task episode as completed with its outcome. This enables the episode to be used for playbook extraction.",
            parameters: Type.Object({
                episode_id: Type.String({ description: "The ID of the episode to complete" }),
                outcome: stringEnum(["success", "failure", "partial"]),
                evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence of task completion" })),
                verification: Type.Optional(Type.Array(Type.String(), { description: "Verification steps performed" })),
                tool_names: Type.Optional(Type.Array(Type.String(), { description: "Tools used during the task" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { episode_id, outcome, evidence, verification, tool_names } = params;
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_episode_complete");
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
                    const episode = getEpisode(db, episode_id, runtime.scopeFilter);
                    if (!episode) {
                        return {
                            content: [{ type: "text", text: `Episode not found: ${episode_id}` }],
                            isError: true,
                        };
                    }
                    if (!updateEpisodeOutcome(db, episode_id, outcome, undefined, runtime.scopeFilter)) {
                        return {
                            content: [{ type: "text", text: `Episode not found: ${episode_id}` }],
                            isError: true,
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Episode ${episode_id} completed with outcome: ${outcome}`,
                            },
                        ],
                        details: {
                            episode_id,
                            outcome,
                            evidence_count: evidence?.length ?? 0,
                            verification_count: verification?.length ?? 0,
                            tool_count: tool_names?.length ?? 0,
                        },
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("episode_complete_failed", "Error completing episode", error);
                }
            },
        };
    });
}
// ============================================================================
// Playbook Tools
// ============================================================================
