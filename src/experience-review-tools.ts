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
  getPlaybook
} from "./experience-store.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;

import {
  resolveExperienceRuntime,
  safeExperienceToolFailure,
  type ExperienceToolContext
} from "./experience-tool-runtime-policy.js";

export function registerPlaybookReviewTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
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
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, runtimeCtx?: unknown) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_playbook_review");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          ensureExperienceSchema(db);

          if (String(params.action) === "supersede") {
            const replacementId = typeof params.superseded_by === "string" ? params.superseded_by.trim() : "";
            if (!replacementId || !getPlaybook(db, replacementId, runtime.scopeFilter)) {
              return {
                content: [{ type: "text", text: "Replacement playbook is missing or outside the current memory boundary." }],
                details: { error: "replacement_playbook_not_accessible" },
                isError: true,
              };
            }
          }

          const { reviewPlaybook } = await import("./experience-store.js");
          const result = reviewPlaybook(db, {
            playbookId: String(params.playbook_id),
            action: String(params.action) as "review" | "promote" | "needs_review" | "quarantine" | "supersede",
            reason: params.reason ? String(params.reason) : undefined,
            supersededBy: params.superseded_by ? String(params.superseded_by) : undefined,
            scopeIds: runtime.scopeFilter,
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
          return safeExperienceToolFailure("playbook_review_failed", "Error reviewing playbook", error);
        }
      },
    };
  });
}

// ============================================================================
// experience_replay
// ============================================================================

export function registerExperienceReplayTool(api: OpenClawPluginApi, context: ExperienceToolContext): void {
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
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal?: unknown,
        _onUpdate?: unknown,
        runtimeCtx?: unknown,
      ) {
        try {
          const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_experience_replay");
          if (runtime.ok === false) return runtime.response;
          const db = await context.db();
          if (!db) {
            return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
          }
          ensureExperienceSchema(db);

          const { runReplaySuite, loadReplayCases } = await import("./experience-replay.js");
          const cases = loadReplayCases(params.cases as any[]);
          const suite = runReplaySuite(db, String(params.playbook_id), cases, runtime.scopeFilter);

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
          return safeExperienceToolFailure("experience_replay_failed", "Error running replay", error);
        }
      },
    };
  });
}

// ============================================================================
// Registration Helper
// ============================================================================
