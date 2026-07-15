/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryRetriever } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import type { MemoryScopeManager } from "./scopes.js";
import { parseAgentIdFromSessionKey, resolveScopeFilter } from "./scopes.js";
import type { TextEmbedder } from "./embedder.js";
import type { WorkspaceBoundaryConfig } from "./workspace-boundary.js";
import type { MdMirrorWriter } from "./tools.js";
import {
  ensureExperienceSchema,
  createTaskEpisode,
  updateEpisodeOutcome,
  getEpisode,
  createPlaybook,
  getPlaybook,
  searchPlaybooks,
  incrementPlaybookCounters,
  getPlaybookVersions,
  createExperienceRun,
  finishExperienceRun,
  listRunsForPlaybook,
  getExperienceStats,
} from "./experience-store.js";
import { ExperienceValidationError, PLAYBOOK_STATUSES, CAPABILITY_CLASSES } from "./experience-models.js";
import { buildForgettingReport, runForgettingWithVectorSync } from "./forgetting.js";
import { applyCleanup, rollbackCleanupBatch } from "./governance-cleanup.js";
import { recoveryReport, scheduleReplay } from "./journal-recovery.js";
import { buildOperatorDashboard } from "./operator-dashboard.js";
import { candidateDebtReport, promoteMemoryCandidates } from "./candidate-promotion.js";
import { graphHygieneReport, repairGraphHygiene } from "./graph-hygiene.js";
import {
  digestRecoveryReport,
  digestReport,
  recoverDigestChunks,
  runDigestPipeline,
} from "./digest-pipeline.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;

// ============================================================================
// Tool Context
// ============================================================================

export interface ExperienceToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: TextEmbedder;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  db: () => Promise<DatabaseSync>;
}

export interface ExperienceToolsOptions {
  enableManagementTools?: boolean;
}

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

export const EXPERIENCE_TOOL_NAMES = [
  "scope_recall_episode_create",
  "scope_recall_episode_complete",
  "scope_recall_playbook_search",
  "scope_recall_playbook_inspect",
  "scope_recall_playbook_create",
  "scope_recall_playbook_feedback",
  "scope_recall_playbook_review",
  "scope_recall_experience_preflight",
  "scope_recall_experience_stats",
  "scope_recall_experience_promote",
  "scope_recall_experience_replay",
  "scope_recall_forgetting_report",
  "scope_recall_forgetting_run",
  "scope_recall_governance_cleanup_report",
  "scope_recall_governance_cleanup_run",
  "scope_recall_memory_candidate_promotion_report",
  "scope_recall_memory_candidate_promotion_run",
  "scope_recall_graph_hygiene_report",
  "scope_recall_graph_hygiene_run",
  "scope_recall_journal_recovery_report",
  "scope_recall_journal_recovery_run",
  "scope_recall_operator_dashboard",
  "scope_recall_digest_report",
  "scope_recall_digest_run",
  "scope_recall_digest_recovery",
] as const;

function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  toolCtx: unknown,
  runtimeCtx: unknown,
): string | undefined {
  const candidates = [runtimeCtx, toolCtx];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.agentId === "string" && record.agentId.trim()) {
      return record.agentId.trim();
    }
    const fromSession = parseAgentIdFromSessionKey(
      typeof record.sessionKey === "string" ? record.sessionKey : undefined,
    );
    if (fromSession) return fromSession;
  }
  return staticAgentId?.trim() || undefined;
}

function missingAgentContextResponse(toolName: string): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text: `${toolName} requires OpenClaw agent runtime context; refusing to use a shared default Experience scope.`,
      },
    ],
    details: { error: "missing_agent_context", tool: toolName },
    isError: true,
  };
}

function resolveExperienceRuntime(
  context: ExperienceToolContext,
  toolCtx: unknown,
  runtimeCtx: unknown,
  toolName: string,
): { ok: true; agentId: string; defaultScope: string; scopeFilter: string[] | undefined; sessionId: string } | { ok: false; response: ToolTextResult } {
  const agentId = resolveRuntimeAgentId(context.agentId, toolCtx, runtimeCtx);
  if (!agentId) return { ok: false, response: missingAgentContextResponse(toolName) };
  const defaultScope = context.scopeManager.getDefaultScope(agentId);
  const scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
  const sessionId =
    (runtimeCtx && typeof runtimeCtx === "object" && typeof (runtimeCtx as Record<string, unknown>).sessionId === "string"
      ? String((runtimeCtx as Record<string, unknown>).sessionId)
      : "") ||
    (toolCtx && typeof toolCtx === "object" && typeof (toolCtx as Record<string, unknown>).sessionId === "string"
      ? String((toolCtx as Record<string, unknown>).sessionId)
      : "") ||
    "unknown";
  return { ok: true, agentId, defaultScope, scopeFilter, sessionId };
}

function registerExperienceTool(
  api: OpenClawPluginApi,
  name: typeof EXPERIENCE_TOOL_NAMES[number],
  factory: (toolCtx?: Record<string, unknown>) => unknown,
): void {
  api.registerTool(factory, { name });
}

function managementDisabledResponse(toolName: string): ToolTextResult {
  return {
    content: [{ type: "text", text: `${toolName} requires enableManagementTools=true.` }],
    details: { error: "management_tools_disabled", tool: toolName },
    isError: true,
  };
}

function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

const PLAYBOOK_STATUS_VALUES = [...PLAYBOOK_STATUSES] as [string, ...string[]];
const CAPABILITY_CLASS_VALUES = [...CAPABILITY_CLASSES] as [string, ...string[]];

// ============================================================================
// Episode Tools
// ============================================================================

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
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
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
          return {
            content: [{ type: "text", text: `Error creating episode: ${error}` }],
            isError: true,
          };
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
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
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

          const episode = getEpisode(db, episode_id);
          if (!episode) {
            return {
              content: [{ type: "text", text: `Episode not found: ${episode_id}` }],
              isError: true,
            };
          }

          updateEpisodeOutcome(db, episode_id, outcome);

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
          return {
            content: [{ type: "text", text: `Error completing episode: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// Playbook Tools
// ============================================================================

export function registerPlaybookSearchTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_playbook_search",
      label: "Search Playbooks",
      description:
        "Search for reusable procedural playbooks by query, task class, or status. Returns matching playbooks with their steps, pitfalls, and verification methods. Use this before starting a task to find relevant experience.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "Search query to match against playbook title, trigger, goal, and steps" }),
        ),
        task_class: Type.Optional(
          Type.String({ description: "Filter by exact task class" }),
        ),
        status: Type.Optional(
          stringEnum(PLAYBOOK_STATUS_VALUES),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of results to return (default: 20)" }),
        ),
      }),
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { query, task_class, status, limit } = params as {
          query?: string;
          task_class?: string;
          status?: string;
          limit?: number;
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_search");
          if (runtime.ok === false) return runtime.response;
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
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error searching playbooks: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

export function registerPlaybookInspectTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_playbook_inspect",
      label: "Inspect Playbook",
      description:
        "Inspect a specific procedural playbook by ID. Returns the full playbook including all steps, pitfalls, verification methods, and recent run history.",
      parameters: Type.Object({
        playbook_id: Type.String({ description: "The ID of the playbook to inspect" }),
      }),
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { playbook_id } = params as { playbook_id: string };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_inspect");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return {
              content: [{ type: "text", text: "Error: SQL truth store not available" }],
              isError: true,
            };
          }
          ensureExperienceSchema(db);

          const playbook = getPlaybook(db, playbook_id);
          if (!playbook) {
            return {
              content: [{ type: "text", text: `Playbook not found: ${playbook_id}` }],
              isError: true,
            };
          }

          const versions = getPlaybookVersions(db, playbook_id);
          const recentRuns = listRunsForPlaybook(db, playbook_id, 5);

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
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error inspecting playbook: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

export function registerPlaybookCreateTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_playbook_create",
      label: "Create Playbook",
      description:
        "Create a new procedural playbook from a successful task episode. The playbook must follow the procedural_playbook.v1 schema with ordered steps, capability classes, and verification requirements. New playbooks start with status 'candidate'.",
      parameters: Type.Object({
        task_class: Type.String({ description: "Task classification" }),
        title: Type.String({ description: "Short descriptive title" }),
        trigger: Type.String({ description: "When should this playbook be used?" }),
        goal: Type.String({ description: "What is the goal of following this playbook?" }),
        preconditions: Type.Array(Type.Object({}, { additionalProperties: true }), {
          description: "List of preconditions",
        }),
        steps: Type.Array(
          Type.Object({
            number: Type.Number(),
            capability_class: stringEnum(CAPABILITY_CLASS_VALUES),
            action: Type.String(),
            evidence_required: Type.String(),
            why: Type.Optional(Type.String()),
            previous_mistakes: Type.Optional(Type.Array(Type.String())),
          }),
          { description: "Ordered steps with capability classification" },
        ),
        pitfalls: Type.Optional(
          Type.Array(Type.Object({}, { additionalProperties: true }), {
            description: "Known pitfalls",
          }),
        ),
        verification: Type.Array(Type.String(), {
          description: "How to verify task completion",
        }),
        cleanup: Type.Optional(Type.Array(Type.String(), { description: "Cleanup steps" })),
        episode_id: Type.Optional(
          Type.String({ description: "Episode this playbook was derived from" }),
        ),
      }),
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const {
          task_class,
          title,
          trigger,
          goal,
          preconditions,
          steps,
          pitfalls,
          verification,
          cleanup,
          episode_id,
        } = params as {
          task_class: string;
          title: string;
          trigger: string;
          goal: string;
          preconditions: Record<string, unknown>[];
          steps: {
            number: number;
            capability_class: string;
            action: string;
            evidence_required: string;
            why?: string;
            previous_mistakes?: string[];
          }[];
          pitfalls?: Record<string, unknown>[];
          verification: string[];
          cleanup?: string[];
          episode_id?: string;
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_create");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return {
              content: [{ type: "text", text: "Error: SQL truth store not available" }],
              isError: true,
            };
          }
          ensureExperienceSchema(db);

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
        } catch (error) {
          if (error instanceof ExperienceValidationError) {
            return {
              content: [{ type: "text", text: `Validation error: ${error.message}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Error creating playbook: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

export function registerPlaybookFeedbackTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_playbook_feedback",
      label: "Playbook Feedback",
      description:
        "Record feedback about a playbook after using it. Tracks success/failure to update playbook confidence and usage statistics.",
      parameters: Type.Object({
        playbook_id: Type.String({ description: "The ID of the playbook being reviewed" }),
        outcome: stringEnum(["success", "failure", "partial"] as const),
        outcome_reason: Type.Optional(Type.String({ description: "Brief explanation of the outcome" })),
        steps_completed: Type.Optional(
          Type.Array(Type.Number(), { description: "Which step numbers were completed" }),
        ),
        evidence: Type.Optional(
          Type.Array(Type.String(), { description: "Evidence collected during execution" }),
        ),
      }),
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const { playbook_id, outcome, outcome_reason, steps_completed, evidence } = params as {
          playbook_id: string;
          outcome: "success" | "failure" | "partial";
          outcome_reason?: string;
          steps_completed?: number[];
          evidence?: string[];
        };

        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_feedback");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return {
              content: [{ type: "text", text: "Error: SQL truth store not available" }],
              isError: true,
            };
          }
          ensureExperienceSchema(db);

          const playbook = getPlaybook(db, playbook_id);
          if (!playbook) {
            return {
              content: [{ type: "text", text: `Playbook not found: ${playbook_id}` }],
              isError: true,
            };
          }

          // Create experience run record
          const run = createExperienceRun(db, {
            playbook_id,
            scope_id: runtime.defaultScope,
            decision: "used",
            confidence_at_use: playbook.confidence,
            steps_completed: steps_completed || [],
            evidence: evidence || [],
            outcome,
            outcome_reason: outcome_reason || "",
          });

          finishExperienceRun(db, run.id, outcome, outcome_reason);

          // Update playbook counters
          incrementPlaybookCounters(db, playbook_id, outcome === "partial" ? "stale" : outcome);

          return {
            content: [
              {
                type: "text",
                text: `Feedback recorded for playbook ${playbook_id}\nOutcome: ${outcome}\nRun ID: ${run.id}`,
              },
            ],
            details: { run_id: run.id, outcome },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error recording feedback: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// Preflight Tool
// ============================================================================

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
      async execute(_toolCallId, params, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
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
          return {
            content: [{ type: "text", text: `Error in preflight check: ${error}` }],
            isError: true,
          };
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

          const stats = getExperienceStats(db, runtime.defaultScope);

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
          return {
            content: [{ type: "text", text: `Error getting stats: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// experience_promote
// ============================================================================

function registerExperiencePromoteTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_experience_promote",
      label: "Auto-Promote Experiences",
      description:
        "Automatically extract reusable playbooks from successful task episodes. Scans completed episodes, classifies risk, and creates structured playbooks. Low-risk playbooks are auto-promoted; high-risk ones are flagged for review. Use dry_run first to preview.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Optional scope filter to limit which episodes are scanned" })),
        dry_run: Type.Optional(Type.Boolean({ description: "If true, only preview what would be created (default: true)" })),
        auto_promote_low_risk: Type.Optional(Type.Boolean({ description: "Auto-promote low-risk playbooks (default: true)" })),
        max_episodes: Type.Optional(Type.Number({ description: "Maximum episodes to scan (default: 50)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_experience_promote");
          if (runtime.ok === false) return runtime.response;
          const { promoteExperiences } = await import("./experience-promotion.js");
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          ensureExperienceSchema(db);

          const result = promoteExperiences(db, {
            scope_id: typeof params.scope === "string" ? params.scope : runtime.defaultScope,
            dry_run: typeof params.dry_run === "boolean" ? params.dry_run : true,
            config: {
              auto_promote_low_risk: typeof params.auto_promote_low_risk === "boolean" ? params.auto_promote_low_risk : true,
              max_episodes: typeof params.max_episodes === "number" ? params.max_episodes : 50,
            },
          });

          const mode = result.dry_run ? "DRY RUN" : "LIVE";
          const summary = `**Experience Promotion (${mode})**

**Episodes:** ${result.episodes_scanned} scanned, ${result.skipped} skipped, ${result.duplicates_skipped} duplicates
**Created:** ${result.playbooks_created} playbooks
**Promoted:** ${result.playbooks_promoted} (auto)
**Needs Review:** ${result.playbooks_needing_review}

**Items:**
${result.items.map((item: any) => {
  const icon = item.action === "created" ? "✅" : item.action === "would_create" ? "🔍" : "⏭️";
  const risk = item.risk_level ? ` [${item.risk_level}]` : "";
  const status = item.status ? ` → ${item.status}` : "";
  return `${icon} ${item.action}: ${item.episode_id?.slice(0, 12) ?? "?"}${risk}${status}`;
}).join("\n") || "No items processed."}`;

          return {
            content: [{ type: "text", text: summary }],
            details: result,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error running promotion: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// forgetting_report
// ============================================================================

function registerForgettingReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_forgetting_report",
      label: "ClawLore Forgetting Report",
      description:
        "Read-only report of low-value, duplicate, wrapper-noise, or secret-like memory rows in SQL truth. Does not mutate memory.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_forgetting_report");
          if (runtime.ok === false) return runtime.response;
          let scopeFilter = runtime.scopeFilter;
          if (typeof params.scope === "string" && params.scope.trim()) {
            const scope = params.scope.trim();
            if (!context.scopeManager.isAccessible(scope, runtime.agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
                isError: true,
              };
            }
            scopeFilter = [scope];
          }
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          const result = buildForgettingReport(db, {
            scopeFilter,
            limit: typeof params.limit === "number" ? params.limit : 200,
          });

          const summary = `ClawLore Forgetting Report

Rows: ${result.active_rows}/${result.total_rows} active
Soft archive candidates: ${result.soft_archive_candidates.count}
Hard delete candidates: ${result.hard_delete_candidates.count}
Duplicate groups: ${result.duplicate_groups.count}

Top candidates:
${result.soft_archive_candidates.items.slice(0, 10).map((item) => `- archive ${item.id.slice(0, 12)} ${item.reason}: ${item.preview}`).join("\n") || "- none"}`;

          return {
            content: [{ type: "text", text: summary }],
            details: result,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error running forgetting loop: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

function registerForgettingRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_forgetting_run",
      label: "ClawLore Forgetting Run",
      description:
        "Apply the forgetting loop to SQL truth. Defaults to dry_run=true and soft-archives low-value rows; hard deleting sensitive rows requires hard_delete_sensitive=true.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth." })),
        hard_delete_sensitive: Type.Optional(Type.Boolean({ description: "Physically delete secret-like rows instead of only reporting them." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_forgetting_run");
          if (runtime.ok === false) return runtime.response;
          let scopeFilter = runtime.scopeFilter;
          if (typeof params.scope === "string" && params.scope.trim()) {
            const scope = params.scope.trim();
            if (!context.scopeManager.isAccessible(scope, runtime.agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
                isError: true,
              };
            }
            scopeFilter = [scope];
          }
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          const result = await runForgettingWithVectorSync(db, {
            scopeFilter,
            dryRun: params.dry_run !== false,
            hardDeleteSensitive: params.hard_delete_sensitive === true,
            limit: typeof params.limit === "number" ? params.limit : 200,
            deleteVectorById: (id, operation) => context.store.deleteVectorCompanion(id, operation),
          });
          return {
            content: [
              {
                type: "text",
                text: `Forgetting run ${result.dry_run ? "preview" : "applied"}: archived=${result.archived}, deleted=${result.deleted}, vector_deleted=${result.vector_deleted ?? 0}${result.needs_repair ? ", needs_repair=true" : ""}`,
              },
            ],
            details: result,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error running forgetting: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// governance_cleanup / journal_recovery / operator_dashboard
// ============================================================================

function registerGovernanceCleanupReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_governance_cleanup_report",
      label: "ClawLore Governance Cleanup Report",
      description:
        "Read-only report for historical template/transcript-shaped memory rows that should be reviewed or soft-archived.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_governance_cleanup_report");
          if (runtime.ok === false) return runtime.response;
          let scopeFilter = runtime.scopeFilter;
          if (typeof params.scope === "string" && params.scope.trim()) {
            const scope = params.scope.trim();
            if (!context.scopeManager.isAccessible(scope, runtime.agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
                isError: true,
              };
            }
            scopeFilter = [scope];
          }
          const db = await context.db();
          if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          const result = applyCleanup(db, {
            scopeFilter,
            dryRun: true,
            limit: typeof params.limit === "number" ? params.limit : 200,
            batchId: "dry-run",
          });
          return {
            content: [{ type: "text", text: `Governance cleanup report: candidates=${result.candidate_count}, reasons=${JSON.stringify(result.reason_counts)}` }],
            details: result,
          };
        } catch (error) {
          return { content: [{ type: "text", text: `Error building governance cleanup report: ${error}` }], isError: true };
        }
      },
    };
  });
}

function registerGovernanceCleanupRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_governance_cleanup_run",
      label: "ClawLore Governance Cleanup Run",
      description:
        "Soft-archive or roll back historical template/transcript-shaped memory rows. Defaults to dry_run=true.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth metadata." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
        batch_id: Type.Optional(Type.String({ description: "Optional rollback batch id. Required for rollback mode." })),
        rollback_batch: Type.Optional(Type.Boolean({ description: "Roll back a previous cleanup batch instead of archiving candidates." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_governance_cleanup_run");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };

          if (params.rollback_batch === true) {
            const batchId = typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : "";
            if (!batchId) {
              return { content: [{ type: "text", text: "batch_id is required when rollback_batch=true" }], isError: true };
            }
            const rollback = rollbackCleanupBatch(db, {
              batchId,
              dryRun: params.dry_run !== false,
              actor: `clawlore:${runtime.agentId}`,
            });
            return {
              content: [{ type: "text", text: `Governance cleanup rollback ${rollback.dry_run ? "preview" : "applied"}: restored=${rollback.restored}/${rollback.rollback_candidates}` }],
              details: rollback,
            };
          }

          let scopeFilter = runtime.scopeFilter;
          if (typeof params.scope === "string" && params.scope.trim()) {
            const scope = params.scope.trim();
            if (!context.scopeManager.isAccessible(scope, runtime.agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
                isError: true,
              };
            }
            scopeFilter = [scope];
          }
          const result = applyCleanup(db, {
            scopeFilter,
            dryRun: params.dry_run !== false,
            limit: typeof params.limit === "number" ? params.limit : 200,
            batchId: typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : undefined,
            actor: `clawlore:${runtime.agentId}`,
          });
          return {
            content: [{ type: "text", text: `Governance cleanup ${result.dry_run ? "preview" : "applied"}: archived=${result.archived}/${result.candidate_count}, batch=${result.batch_id}` }],
            details: result,
          };
        } catch (error) {
          return { content: [{ type: "text", text: `Error running governance cleanup: ${error}` }], isError: true };
        }
      },
    };
  });
}

function registerMemoryCandidatePromotionReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_memory_candidate_promotion_report",
      label: "ClawLore Memory Candidate Promotion Report",
      description:
        "Read-only candidate-memory debt report. Shows promotable, kept, and optional archive candidates before any lifecycle mutation.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to inspect (default: 1000)" })),
        sample_limit: Type.Optional(Type.Number({ description: "Maximum redacted samples to return (default: 8)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_memory_candidate_promotion_report");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const result = candidateDebtReport(db, {
          limit: typeof params.limit === "number" ? params.limit : 1000,
          sampleLimit: typeof params.sample_limit === "number" ? params.sample_limit : 8,
        });
        const byAction = (result.by_action || {}) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `Candidate promotion report: status=${result.status}, candidates=${result.candidate_count}, promote=${byAction.promote ?? 0}, archive=${byAction.archive ?? 0}, keep=${byAction.keep_candidate ?? 0}` }],
          details: result,
        };
      },
    };
  });
}

function registerMemoryCandidatePromotionRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_memory_candidate_promotion_run",
      label: "ClawLore Memory Candidate Promotion Run",
      description:
        "Dry-run-by-default candidate-memory lifecycle promotion. Set dry_run=false to promote safe ordinary candidates; archive_noise must also be true to archive low-value noise.",
      parameters: Type.Object({
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth metadata." })),
        archive_noise: Type.Optional(Type.Boolean({ description: "With dry_run=false, also archive rows classified as low-value noise." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 1000)" })),
        batch_id: Type.Optional(Type.String({ description: "Optional governance audit batch id." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_memory_candidate_promotion_run");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const result = promoteMemoryCandidates(db, {
          dryRun: params.dry_run !== false,
          archiveNoise: params.archive_noise === true,
          limit: typeof params.limit === "number" ? params.limit : 1000,
          batchId: typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : undefined,
          actor: `clawlore:${runtime.agentId}`,
        });
        const mutations = (result.mutations || {}) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `Candidate promotion ${result.dry_run ? "preview" : "applied"}: promoted=${mutations.promoted ?? 0}, archived=${mutations.archived ?? 0}, kept=${mutations.kept ?? 0}, batch=${result.batch_id ?? ""}` }],
          details: result,
        };
      },
    };
  });
}

function registerGraphHygieneReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_graph_hygiene_report",
      label: "ClawLore Graph Hygiene Report",
      description:
        "Read-only report for rebuildable graph companion rows that are orphaned or point at hidden lifecycle memories. Reports unsupported when graph tables are absent.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_graph_hygiene_report");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const result = graphHygieneReport(db);
        const counts = (result.counts || {}) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `Graph hygiene report: status=${result.status}, orphan_entities=${counts.orphan_entities ?? 0}, orphan_relations=${counts.orphan_relations ?? 0}, hidden_relations=${counts.hidden_lifecycle_relations ?? 0}` }],
          details: result,
        };
      },
    };
  });
}

function registerGraphHygieneRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_graph_hygiene_run",
      label: "ClawLore Graph Hygiene Run",
      description:
        "Dry-run-by-default graph companion repair. Set dry_run=false to remove orphan/hidden-lifecycle rows from rebuildable graph tables.",
      parameters: Type.Object({
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to delete rebuildable companion rows." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_graph_hygiene_run");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const result = repairGraphHygiene(db, {
          dryRun: params.dry_run !== false,
        });
        const deleted = (result.deleted || {}) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `Graph hygiene ${result.dry_run ? "preview" : "applied"}: status=${result.status}, deleted_entities=${deleted.memory_entities ?? 0}, deleted_relations=${deleted.memory_relations ?? 0}` }],
          details: result,
        };
      },
    };
  });
}

function registerJournalRecoveryReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_journal_recovery_report",
      label: "ClawLore Journal Recovery Report",
      description:
        "Read-only report of retry-exhausted or dead-letter journal entries that can be replayed. Returns unsupported when this OpenClaw deployment has no journal tables.",
      parameters: Type.Object({
        include_dead_letters: Type.Optional(Type.Boolean({ description: "Include dead-letter rejections as replay candidates." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_journal_recovery_report");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const reasonPrefixes = params.include_dead_letters === true ? ["retry-exhausted:", "dead-letter:"] : ["retry-exhausted:"];
        const result = recoveryReport(db, {
          reasonPrefixes,
          limit: typeof params.limit === "number" ? params.limit : 200,
        });
        return {
          content: [{ type: "text", text: `Journal recovery report: status=${result.status}, candidates=${result.candidate_count}` }],
          details: result,
        };
      },
    };
  });
}

function registerJournalRecoveryRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_journal_recovery_run",
      label: "ClawLore Journal Recovery Run",
      description:
        "Schedule retry-exhausted/dead-letter journal entries for replay. Defaults to dry_run=true.",
      parameters: Type.Object({
        include_dead_letters: Type.Optional(Type.Boolean({ description: "Include dead-letter rejections as replay candidates." })),
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to reopen journal entries." })),
        limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
        batch_id: Type.Optional(Type.String({ description: "Optional audit batch id." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_journal_recovery_run");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const reasonPrefixes = params.include_dead_letters === true ? ["retry-exhausted:", "dead-letter:"] : ["retry-exhausted:"];
        const result = scheduleReplay(db, {
          reasonPrefixes,
          dryRun: params.dry_run !== false,
          limit: typeof params.limit === "number" ? params.limit : 200,
          batchId: typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : undefined,
          actor: `clawlore:${runtime.agentId}`,
        });
        return {
          content: [{ type: "text", text: `Journal recovery ${result.dry_run ? "preview" : "applied"}: status=${result.status}, scheduled=${result.scheduled}/${result.candidate_count}` }],
          details: result,
        };
      },
    };
  });
}

function registerDigestReportTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_digest_report",
      label: "ClawLore Digest Report",
      description:
        "Read-only report for OpenClaw-native digest ledger, failed runs, chunk states, and digest candidate debt.",
      parameters: Type.Object({
        sample_limit: Type.Optional(Type.Number({ description: "Maximum redacted chunk samples to return (default: 8)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_report");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const result = digestReport(db, {
          sampleLimit: typeof params.sample_limit === "number" ? params.sample_limit : 8,
        });
        return {
          content: [{ type: "text", text: `OpenClaw digest report: status=${result.status}, candidate_debt=${result.candidate_debt ?? 0}, failed_runs=${result.failed_runs ?? 0}` }],
          details: result,
        };
      },
    };
  });
}

function registerDigestRunTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_digest_run",
      label: "ClawLore Digest Run",
      description:
        "Run OpenClaw-native digest extraction. Defaults to dry_run=true and writes only candidate memories when dry_run=false.",
      parameters: Type.Object({
        text: Type.Optional(Type.String({ description: "Explicit digest input text. If omitted, recent reflection events are used." })),
        scope: Type.Optional(Type.String({ description: "Optional exact target scope. Defaults to current agent scope." })),
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to write digest candidates." })),
        max_chunks: Type.Optional(Type.Number({ description: "Maximum reflection chunks when no explicit text is provided (default: 25)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_run");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };

        let scope = `agent:${runtime.agentId}`;
        if (typeof params.scope === "string" && params.scope.trim()) {
          scope = params.scope.trim();
          if (!context.scopeManager.isAccessible(scope, runtime.agentId)) {
            return {
              content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
              details: { error: "scope_access_denied", requestedScope: scope },
              isError: true,
            };
          }
        }

        const result = await runDigestPipeline(db, {
          apply: params.dry_run === false,
          scope,
          inputText: typeof params.text === "string" && params.text.trim() ? params.text : undefined,
          sourceId: typeof params.text === "string" && params.text.trim() ? "tool-text" : undefined,
          sourceType: typeof params.text === "string" && params.text.trim() ? "explicit" : "reflection_event",
          maxChunks: typeof params.max_chunks === "number" ? params.max_chunks : 25,
          store: context.store,
          embedPassage: (text) => context.embedder.embedPassage(text),
          actor: `clawlore:${runtime.agentId}`,
        });
        return {
          content: [{ type: "text", text: `OpenClaw digest ${result.dry_run ? "preview" : "run"}: status=${result.status}, extracted=${result.extracted}, stored=${result.stored}, skipped=${result.skipped}` }],
          details: result,
          ...(result.ok ? {} : { isError: true }),
        };
      },
    };
  });
}

function registerDigestRecoveryTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_digest_recovery",
      label: "ClawLore Digest Recovery",
      description:
        "Report or schedule recovery for OpenClaw-native digest parse/retry/dead-letter chunks. Defaults to dry_run=true.",
      parameters: Type.Object({
        dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mark chunks pending_recovery." })),
        limit: Type.Optional(Type.Number({ description: "Maximum recovery candidates to process (default: 100)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_recovery");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const limit = typeof params.limit === "number" ? params.limit : 100;
        const result = params.dry_run === false
          ? recoverDigestChunks(db, {
              dryRun: false,
              limit,
              actor: `clawlore:${runtime.agentId}`,
            })
          : { ...digestRecoveryReport(db, { limit }), dry_run: true };
        return {
          content: [{ type: "text", text: `OpenClaw digest recovery ${params.dry_run === false ? "scheduled" : "preview"}: status=${result.status}, candidates=${result.candidate_count ?? 0}, recovered=${result.recovered ?? 0}` }],
          details: result,
        };
      },
    };
  });
}

function registerOperatorDashboardTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_operator_dashboard",
      label: "ClawLore Operator Dashboard",
      description:
        "Read-only operator dashboard summarizing SQL truth, FTS, governance cleanup, journal recovery, Experience Kernel, and vector status.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_operator_dashboard");
        if (runtime.ok === false) return runtime.response;
        const db = await context.db();
        if (!db) return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
        const dashboard = buildOperatorDashboard(db, {
          vectorStatus: (context.store as any).getDiagnostics?.().vectorCompanion as Record<string, unknown> | undefined,
        });
        const summary = dashboard.summary as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `ClawLore dashboard: memories=${summary.memory_rows}, fts=${summary.fts_status}, governance=${summary.governance_cleanup_candidates}, candidates=${summary.memory_candidate_debt}, graph=${summary.graph_hygiene_status}, journal=${summary.journal_recovery_status}/${summary.journal_replay_candidates}, digest=${summary.digest_status}/${summary.digest_candidate_debt}, experience=${summary.experience_status}` }],
          details: dashboard,
        };
      },
    };
  });
}

// ============================================================================
// playbook_review
// ============================================================================

function registerPlaybookReviewTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_playbook_review",
      label: "Review Playbook",
      description:
        "Formally review a playbook and update its status. Actions: review (mark as reviewed), promote (approve for reuse), needs_review (flag for further review), quarantine (isolate due to issues), supersede (mark as replaced by another playbook).",
      parameters: Type.Object({
        playbook_id: Type.String({ description: "The playbook ID to review" }),
        action: Type.Union([
          Type.Literal("review"),
          Type.Literal("promote"),
          Type.Literal("needs_review"),
          Type.Literal("quarantine"),
          Type.Literal("supersede"),
        ], { description: "Review action" }),
        reason: Type.Optional(Type.String({ description: "Reason for the review decision" })),
        superseded_by: Type.Optional(Type.String({ description: "If superseding, the ID of the replacement playbook" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          ensureExperienceSchema(db);

          const { reviewPlaybook } = await import("./experience-store.js");
          const result = reviewPlaybook(db, {
            playbookId: String(params.playbook_id),
            action: String(params.action) as "review" | "promote" | "needs_review" | "quarantine" | "supersede",
            reason: params.reason ? String(params.reason) : undefined,
            supersededBy: params.superseded_by ? String(params.superseded_by) : undefined,
          });

          if (!result.reviewed) {
            return {
              content: [{ type: "text", text: `❌ Review failed: ${result.error}` }],
              isError: true,
            };
          }

          const summary = `**Playbook Review Complete**

**Playbook:** ${result.id}
**Action:** ${params.action}
**New Status:** ${result.status}
**Version:** ${result.version}
${params.reason ? `**Reason:** ${params.reason}` : ""}`;

          return {
            content: [{ type: "text", text: summary }],
            details: result,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error reviewing playbook: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// experience_replay
// ============================================================================

function registerExperienceReplayTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
  api.registerTool((toolCtx) => {
    return {
      name: "scope_recall_experience_replay",
      label: "Replay Test Playbook",
      description:
        "Validate a playbook against test cases. Checks if the playbook contains required terms and avoids negative terms. Useful for verifying auto-generated playbooks before promotion.",
      parameters: Type.Object({
        playbook_id: Type.String({ description: "The playbook ID to test" }),
        cases: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: "Case ID" })),
          name: Type.String({ description: "Case name" }),
          required_terms: Type.Array(Type.String(), { description: "Terms that must be present" }),
          negative_terms: Type.Optional(Type.Array(Type.String(), { description: "Terms that must NOT be present" })),
        }), { description: "Test cases to run" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          ensureExperienceSchema(db);

          const { runReplaySuite, loadReplayCases } = await import("./experience-replay.js");
          const cases = loadReplayCases(params.cases as any[]);
          const suite = runReplaySuite(db, String(params.playbook_id), cases);

          const summary = `**Replay Test Results**

**Playbook:** ${params.playbook_id}
**Total:** ${suite.total} | **Passed:** ${suite.passed} | **Failed:** ${suite.failed}

**Results:**
${suite.results.map((r: any) => {
  const icon = r.passed ? "✅" : "❌";
  const coverage = Math.round(r.coverage_ratio * 100);
  return `${icon} ${r.case_name}: ${coverage}% coverage${r.negative_hits.length > 0 ? `, ${r.negative_hits.length} negative hits` : ""}`;
}).join("\n")}`;

          return {
            content: [{ type: "text", text: summary }],
            details: suite,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error running replay: ${error}` }],
            isError: true,
          };
        }
      },
    };
  });
}

// ============================================================================
// Registration Helper
// ============================================================================

export function registerExperienceTools(
  api: OpenClawPluginApi,
  context: ExperienceToolContext,
  options: ExperienceToolsOptions = {},
): void {
  const apiWithMetadata: OpenClawPluginApi = {
    ...api,
    registerTool(factory, metadata) {
      if (metadata?.name) {
        api.registerTool(factory, metadata);
        return;
      }
      const probe = factory({});
      const name = probe && typeof probe === "object" && typeof (probe as { name?: unknown }).name === "string"
        ? String((probe as { name: string }).name)
        : "";
      if (!name) {
        throw new Error("Experience Kernel tool registration requires a tool name");
      }
      api.registerTool(factory, { name });
    },
  };

  registerPlaybookSearchTool(apiWithMetadata, context);
  registerPlaybookInspectTool(apiWithMetadata, context);
  registerExperiencePreflightTool(apiWithMetadata, context);

  if (options.enableManagementTools === true) {
    registerExperienceStatsTool(apiWithMetadata, context);
    registerExperienceReplayTool(apiWithMetadata, context);
    registerEpisodeCreateTool(apiWithMetadata, context);
    registerEpisodeCompleteTool(apiWithMetadata, context);
    registerPlaybookCreateTool(apiWithMetadata, context);
    registerPlaybookFeedbackTool(apiWithMetadata, context);
    registerExperiencePromoteTool(apiWithMetadata, context);
    registerForgettingReportTool(apiWithMetadata, context);
    registerForgettingRunTool(apiWithMetadata, context);
    registerGovernanceCleanupReportTool(apiWithMetadata, context);
    registerGovernanceCleanupRunTool(apiWithMetadata, context);
    registerMemoryCandidatePromotionReportTool(apiWithMetadata, context);
    registerMemoryCandidatePromotionRunTool(apiWithMetadata, context);
    registerGraphHygieneReportTool(apiWithMetadata, context);
    registerGraphHygieneRunTool(apiWithMetadata, context);
    registerJournalRecoveryReportTool(apiWithMetadata, context);
    registerJournalRecoveryRunTool(apiWithMetadata, context);
    registerDigestReportTool(apiWithMetadata, context);
    registerDigestRunTool(apiWithMetadata, context);
    registerDigestRecoveryTool(apiWithMetadata, context);
    registerOperatorDashboardTool(apiWithMetadata, context);
    registerPlaybookReviewTool(apiWithMetadata, context);
  }
}
