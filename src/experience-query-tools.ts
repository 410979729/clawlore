/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  ensureExperienceSchema,
  getExperienceStats,
  searchPlaybooks
} from "./experience-store.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;

import {
  resolveExperienceRuntime,
  safeExperienceToolFailure,
  type ExperienceToolContext
} from "./experience-tool-runtime-policy.js";

export function registerExperiencePreflightTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_experience_preflight",
      label: "Experience Preflight",
      description:
        "Check if there are relevant playbooks for a task before starting. Returns matching playbooks with their steps and verification methods. Use this to leverage accumulated experience.",
      parameters: Type.Object({
        task_description: Type.String({ description: "Description of the task you're about to perform" }),
        task_class: Type.Optional(Type.String({ description: "Optional task class filter" })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { task_description, task_class } = params as {
          task_description: string;
          task_class?: string;
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_experience_preflight");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return {
              content: [{ type: "text", text: "Error: SQL truth store not available" }],
              isError: true,
            };
          }
          ensureExperienceSchema(db);

          // Search for relevant playbooks (only promoted ones)
          const playbooks = searchPlaybooks(db, {
            query: task_description,
            scope_ids: runtime.scopeFilter,
            task_class,
            status: "promoted",
            limit: 5,
          });

          if (playbooks.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No relevant playbooks found for this task. Proceed with standard approach.",
                },
              ],
              details: { found: false, count: 0 },
            };
          }

          // Format playbook guidance
          const guidance = playbooks.map((p) => ({
            id: p.id,
            title: p.title,
            confidence: p.confidence,
            trigger: p.trigger,
            goal: p.goal,
            steps: p.steps.map((s) => ({
              number: s.number,
              action: s.action,
              evidence_required: s.evidence_required,
              capability_class: s.capability_class,
            })),
            pitfalls: p.pitfalls,
            verification: p.verification,
          }));

          const summary = `Found ${playbooks.length} relevant playbook(s). Follow these steps:\n\n${guidance
            .map(
              (p) =>
                `## ${p.title} (confidence: ${p.confidence})\n\n` +
                `**Goal:** ${p.goal}\n\n` +
                `**Steps:**\n${p.steps.map((s) => `${s.number}. ${s.action} [${s.capability_class}]`).join("\n")}\n\n` +
                `**Verification:** ${p.verification.join(", ")}`,
            )
            .join("\n\n---\n\n")}`;

          return {
            content: [{ type: "text", text: summary }],
            details: { found: true, count: playbooks.length, playbooks: guidance },
          };
        } catch (error) {
          return safeExperienceToolFailure("experience_preflight_failed", "Error in preflight check", error);
        }
      },
    };
  });
}

// ============================================================================
// Stats Tool
// ============================================================================

export function registerExperienceStatsTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_experience_stats",
      label: "Experience Stats",
      description:
        "Get statistics about the Experience Kernel: episode counts, playbook counts by status, and run success rates.",
      parameters: Type.Object({}),
      async execute(_toolCallId?: string, _params?: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_experience_stats");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return {
              content: [{ type: "text", text: "Error: SQL truth store not available" }],
              isError: true,
            };
          }
          ensureExperienceSchema(db);

          const stats = getExperienceStats(db, runtime.scopeFilter);

          const summary = `Experience Kernel Statistics (scope: ${runtime.defaultScope}):

**Episodes:**
- Total: ${stats.episodes.total}
- Open: ${stats.episodes.open}
- Completed: ${stats.episodes.completed}
- Failed: ${stats.episodes.failed}

**Playbooks:**
- Total: ${stats.playbooks.total}
- Candidate: ${stats.playbooks.candidate}
- Reviewed: ${stats.playbooks.reviewed}
- Promoted: ${stats.playbooks.promoted}
- Needs Review: ${stats.playbooks.needs_review}
- Quarantined: ${stats.playbooks.quarantined}

**Runs:**
- Total: ${stats.runs.total}
- Success: ${stats.runs.success}
- Failure: ${stats.runs.failure}
- Success Rate: ${stats.runs.total > 0 ? ((stats.runs.success / stats.runs.total) * 100).toFixed(1) : 0}%`;

          return {
            content: [{ type: "text", text: summary }],
            details: stats,
          };
        } catch (error) {
          return safeExperienceToolFailure("experience_stats_failed", "Error getting experience stats", error);
        }
      },
    };
  });
}

// ============================================================================
// experience_promote
// ============================================================================
