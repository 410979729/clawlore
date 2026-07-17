/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createTaskEpisode,
  ensureExperienceSchema,
  getEpisode,
  updateEpisodeOutcome
} from "./experience-store.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;

import {
  resolveExperienceRuntime,
  safeExperienceToolFailure,
  stringEnum,
  type ExperienceToolContext
} from "./experience-tool-runtime-policy.js";

export function registerEpisodeCreateTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_episode_create",
      label: "Create Task Episode",
      description:
        "Record the start of a task episode. Episodes track task execution for later playbook extraction. Call this at the start of a significant task.",
      parameters: Type.Object({
        task_goal: Type.String({ description: "What is the goal of this task?" }),
        task_class: Type.Optional(
          Type.String({ description: "Task classification (e.g., 'config_change', 'debugging', 'deployment')" }),
        ),
        user_intent: Type.Optional(Type.String({ description: "What the user asked for" })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { task_goal, task_class, user_intent } = params as {
          task_goal: string;
          task_class?: string;
          user_intent?: string;
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_episode_create");
          if (runtime.ok === false) return runtime.response;
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
                text: `Episode created: ${episode.id}\nTask: ${episode.task_goal}\nStatus: ${episode.status}`,
              },
            ],
            details: { episode_id: episode.id, status: episode.status },
          };
        } catch (error) {
          return safeExperienceToolFailure("episode_create_failed", "Error creating episode", error);
        }
      },
    };
  });
}

export function registerEpisodeCompleteTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_episode_complete",
      label: "Complete Task Episode",
      description:
        "Mark a task episode as completed with its outcome. This enables the episode to be used for playbook extraction.",
      parameters: Type.Object({
        episode_id: Type.String({ description: "The ID of the episode to complete" }),
        outcome: stringEnum(["success", "failure", "partial"] as const),
        evidence: Type.Optional(
          Type.Array(Type.String(), { description: "Evidence of task completion" }),
        ),
        verification: Type.Optional(
          Type.Array(Type.String(), { description: "Verification steps performed" }),
        ),
        tool_names: Type.Optional(
          Type.Array(Type.String(), { description: "Tools used during the task" }),
        ),
      }),
      async execute(_toolCallId: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { episode_id, outcome, evidence, verification, tool_names } = params as {
          episode_id: string;
          outcome: "success" | "failure" | "partial";
          evidence?: string[];
          verification?: string[];
          tool_names?: string[];
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_episode_complete");
          if (runtime.ok === false) return runtime.response;
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
            details: { episode_id, outcome, evidence, verification, tool_names },
          };
        } catch (error) {
          return safeExperienceToolFailure("episode_complete_failed", "Error completing episode", error);
        }
      },
    };
  });
}

// ============================================================================
// Playbook Tools
// ============================================================================
