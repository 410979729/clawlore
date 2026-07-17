/**
 * Experience Kernel - Tool Implementations
 *
 * Registers Experience Kernel tools with the OpenClaw plugin API
 * Follows the same pattern as tools.ts
 */
import { Type } from "@sinclair/typebox";
import { candidateDebtReport, promoteMemoryCandidates } from "./candidate-promotion.js";
import { digestRecoveryReport, digestReport, recoverDigestChunks, runDigestPipeline, } from "./digest-pipeline.js";
import { ensureExperienceSchema } from "./experience-store.js";
import { buildForgettingReport, runForgettingWithVectorSync } from "./forgetting.js";
import { applyCleanup, rollbackCleanupBatch } from "./governance-cleanup.js";
import { graphHygieneReport, repairGraphHygiene } from "./graph-hygiene.js";
import { recoveryReport, scheduleReplay } from "./journal-recovery.js";
import { buildOperatorDashboard } from "./operator-dashboard.js";
import { globalExperienceOperatorDeniedResponse, resolveExperienceRuntime, safeExperienceToolFailure } from "./experience-tool-runtime-policy.js";
export function registerExperiencePromoteTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_experience_promote",
            label: "Auto-Promote Experiences",
            description: "Automatically extract reusable playbooks from successful task episodes. Scans completed episodes, classifies risk, and creates structured playbooks. Low-risk playbooks are auto-promoted; high-risk ones are flagged for review. Use dry_run first to preview.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional scope filter to limit which episodes are scanned" })),
                dry_run: Type.Optional(Type.Boolean({ description: "If true, only preview what would be created (default: true)" })),
                auto_promote_low_risk: Type.Optional(Type.Boolean({ description: "Auto-promote low-risk playbooks (default: true)" })),
                max_episodes: Type.Optional(Type.Number({ description: "Maximum episodes to scan (default: 50)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_experience_promote");
                    if (runtime.ok === false)
                        return runtime.response;
                    const { promoteExperiences } = await import("./experience-promotion.js");
                    const db = await context.db();
                    if (!db) {
                        return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                    }
                    ensureExperienceSchema(db);
                    const requestedScope = typeof params.scope === "string" && params.scope.trim()
                        ? params.scope.trim()
                        : runtime.defaultScope;
                    if (!runtime.isAccessible(requestedScope)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${requestedScope}` }],
                            details: { error: "scope_access_denied", requestedScope },
                            isError: true,
                        };
                    }
                    const result = promoteExperiences(db, {
                        scope_id: requestedScope,
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
${result.items.map((item) => {
                        const icon = item.action === "created" ? "✅" : item.action === "would_create" ? "🔍" : "⏭️";
                        const risk = item.risk_level ? ` [${item.risk_level}]` : "";
                        const status = item.status ? ` → ${item.status}` : "";
                        return `${icon} ${item.action}: ${item.episode_id?.slice(0, 12) ?? "?"}${risk}${status}`;
                    }).join("\n") || "No items processed."}`;
                    return {
                        content: [{ type: "text", text: summary }],
                        details: result,
                    };
                }
                catch (error) {
                    return safeExperienceToolFailure("experience_promotion_failed", "Error running promotion", error);
                }
            },
        };
    });
}
// ============================================================================
// forgetting_report
// ============================================================================
export function registerForgettingReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_forgetting_report",
            label: "ClawLore Forgetting Report",
            description: "Read-only report of low-value, duplicate, wrapper-noise, or secret-like memory rows in SQL truth. Does not mutate memory.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_forgetting_report");
                    if (runtime.ok === false)
                        return runtime.response;
                    let scopeFilter = runtime.scopeFilter;
                    if (typeof params.scope === "string" && params.scope.trim()) {
                        const scope = params.scope.trim();
                        if (!runtime.isAccessible(scope)) {
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
                }
                catch (error) {
                    return safeExperienceToolFailure("forgetting_report_failed", "Error running forgetting report", error);
                }
            },
        };
    });
}
export function registerForgettingRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_forgetting_run",
            label: "ClawLore Forgetting Run",
            description: "Apply the forgetting loop to SQL truth. Defaults to dry_run=true and soft-archives low-value rows; hard deleting sensitive rows requires hard_delete_sensitive=true.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth." })),
                hard_delete_sensitive: Type.Optional(Type.Boolean({ description: "Physically delete secret-like rows instead of only reporting them." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_forgetting_run");
                    if (runtime.ok === false)
                        return runtime.response;
                    let scopeFilter = runtime.scopeFilter;
                    if (typeof params.scope === "string" && params.scope.trim()) {
                        const scope = params.scope.trim();
                        if (!runtime.isAccessible(scope)) {
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
                }
                catch (error) {
                    return safeExperienceToolFailure("forgetting_run_failed", "Error running forgetting", error);
                }
            },
        };
    });
}
// ============================================================================
// governance_cleanup / journal_recovery / operator_dashboard
// ============================================================================
export function registerGovernanceCleanupReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_governance_cleanup_report",
            label: "ClawLore Governance Cleanup Report",
            description: "Read-only report for historical template/transcript-shaped memory rows that should be reviewed or soft-archived.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_governance_cleanup_report");
                    if (runtime.ok === false)
                        return runtime.response;
                    let scopeFilter = runtime.scopeFilter;
                    if (typeof params.scope === "string" && params.scope.trim()) {
                        const scope = params.scope.trim();
                        if (!runtime.isAccessible(scope)) {
                            return {
                                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                                details: { error: "scope_access_denied", requestedScope: scope },
                                isError: true,
                            };
                        }
                        scopeFilter = [scope];
                    }
                    const db = await context.db();
                    if (!db)
                        return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
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
                }
                catch (error) {
                    return safeExperienceToolFailure("governance_cleanup_report_failed", "Error building governance cleanup report", error);
                }
            },
        };
    });
}
export function registerGovernanceCleanupRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_governance_cleanup_run",
            label: "ClawLore Governance Cleanup Run",
            description: "Soft-archive or roll back historical template/transcript-shaped memory rows. Defaults to dry_run=true.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional exact memory scope. Defaults to current agent-accessible scopes." })),
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth metadata." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
                batch_id: Type.Optional(Type.String({ description: "Optional rollback batch id. Required for rollback mode." })),
                rollback_batch: Type.Optional(Type.Boolean({ description: "Roll back a previous cleanup batch instead of archiving candidates." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_governance_cleanup_run");
                    if (runtime.ok === false)
                        return runtime.response;
                    const db = await context.db();
                    if (!db)
                        return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                    if (params.rollback_batch === true) {
                        if (!runtime.systemBypass) {
                            return globalExperienceOperatorDeniedResponse("scope_recall_governance_cleanup_run");
                        }
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
                        if (!runtime.isAccessible(scope)) {
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
                }
                catch (error) {
                    return safeExperienceToolFailure("governance_cleanup_run_failed", "Error running governance cleanup", error);
                }
            },
        };
    });
}
export function registerMemoryCandidatePromotionReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_memory_candidate_promotion_report",
            label: "ClawLore Memory Candidate Promotion Report",
            description: "Read-only candidate-memory debt report. Shows promotable, kept, and optional archive candidates before any lifecycle mutation.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to inspect (default: 1000)" })),
                sample_limit: Type.Optional(Type.Number({ description: "Maximum redacted samples to return (default: 8)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_memory_candidate_promotion_report");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_memory_candidate_promotion_report");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                const result = candidateDebtReport(db, {
                    limit: typeof params.limit === "number" ? params.limit : 1000,
                    sampleLimit: typeof params.sample_limit === "number" ? params.sample_limit : 8,
                });
                const byAction = (result.by_action || {});
                return {
                    content: [{ type: "text", text: `Candidate promotion report: status=${result.status}, candidates=${result.candidate_count}, promote=${byAction.promote ?? 0}, archive=${byAction.archive ?? 0}, keep=${byAction.keep_candidate ?? 0}` }],
                    details: result,
                };
            },
        };
    });
}
export function registerMemoryCandidatePromotionRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_memory_candidate_promotion_run",
            label: "ClawLore Memory Candidate Promotion Run",
            description: "Dry-run-by-default candidate-memory lifecycle promotion. Set dry_run=false to promote safe ordinary candidates; archive_noise must also be true to archive low-value noise.",
            parameters: Type.Object({
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mutate SQL truth metadata." })),
                archive_noise: Type.Optional(Type.Boolean({ description: "With dry_run=false, also archive rows classified as low-value noise." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 1000)" })),
                batch_id: Type.Optional(Type.String({ description: "Optional governance audit batch id." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_memory_candidate_promotion_run");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_memory_candidate_promotion_run");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                const result = promoteMemoryCandidates(db, {
                    dryRun: params.dry_run !== false,
                    archiveNoise: params.archive_noise === true,
                    limit: typeof params.limit === "number" ? params.limit : 1000,
                    batchId: typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : undefined,
                    actor: `clawlore:${runtime.agentId}`,
                });
                const mutations = (result.mutations || {});
                return {
                    content: [{ type: "text", text: `Candidate promotion ${result.dry_run ? "preview" : "applied"}: promoted=${mutations.promoted ?? 0}, archived=${mutations.archived ?? 0}, kept=${mutations.kept ?? 0}, batch=${result.batch_id ?? ""}` }],
                    details: result,
                };
            },
        };
    });
}
export function registerGraphHygieneReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_graph_hygiene_report",
            label: "ClawLore Graph Hygiene Report",
            description: "Read-only report for rebuildable graph companion rows that are orphaned or point at hidden lifecycle memories. Reports unsupported when graph tables are absent.",
            parameters: Type.Object({}),
            async execute(_toolCallId, _params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_graph_hygiene_report");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_graph_hygiene_report");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                const result = graphHygieneReport(db);
                const counts = (result.counts || {});
                return {
                    content: [{ type: "text", text: `Graph hygiene report: status=${result.status}, orphan_entities=${counts.orphan_entities ?? 0}, orphan_relations=${counts.orphan_relations ?? 0}, hidden_relations=${counts.hidden_lifecycle_relations ?? 0}` }],
                    details: result,
                };
            },
        };
    });
}
export function registerGraphHygieneRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_graph_hygiene_run",
            label: "ClawLore Graph Hygiene Run",
            description: "Dry-run-by-default graph companion repair. Set dry_run=false to remove orphan/hidden-lifecycle rows from rebuildable graph tables.",
            parameters: Type.Object({
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to delete rebuildable companion rows." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_graph_hygiene_run");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_graph_hygiene_run");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                const result = repairGraphHygiene(db, {
                    dryRun: params.dry_run !== false,
                });
                const deleted = (result.deleted || {});
                return {
                    content: [{ type: "text", text: `Graph hygiene ${result.dry_run ? "preview" : "applied"}: status=${result.status}, deleted_entities=${deleted.memory_entities ?? 0}, deleted_relations=${deleted.memory_relations ?? 0}` }],
                    details: result,
                };
            },
        };
    });
}
export function registerJournalRecoveryReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_journal_recovery_report",
            label: "ClawLore Journal Recovery Report",
            description: "Read-only report of retry-exhausted or dead-letter journal entries that can be replayed. Returns unsupported when this OpenClaw deployment has no journal tables.",
            parameters: Type.Object({
                include_dead_letters: Type.Optional(Type.Boolean({ description: "Include dead-letter rejections as replay candidates." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default: 200)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_journal_recovery_report");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_journal_recovery_report");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
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
export function registerJournalRecoveryRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_journal_recovery_run",
            label: "ClawLore Journal Recovery Run",
            description: "Schedule retry-exhausted/dead-letter journal entries for replay. Defaults to dry_run=true.",
            parameters: Type.Object({
                include_dead_letters: Type.Optional(Type.Boolean({ description: "Include dead-letter rejections as replay candidates." })),
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to reopen journal entries." })),
                limit: Type.Optional(Type.Number({ description: "Maximum candidates to process (default: 200)" })),
                batch_id: Type.Optional(Type.String({ description: "Optional audit batch id." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_journal_recovery_run");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_journal_recovery_run");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
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
export function registerDigestReportTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_digest_report",
            label: "ClawLore Digest Report",
            description: "Read-only report for OpenClaw-native digest ledger, failed runs, chunk states, and digest candidate debt.",
            parameters: Type.Object({
                sample_limit: Type.Optional(Type.Number({ description: "Maximum redacted chunk samples to return (default: 8)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_report");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_digest_report");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
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
export function registerDigestRunTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_digest_run",
            label: "ClawLore Digest Run",
            description: "Run OpenClaw-native digest extraction. Defaults to dry_run=true and writes only candidate memories when dry_run=false.",
            parameters: Type.Object({
                text: Type.Optional(Type.String({ description: "Explicit digest input text. If omitted, recent reflection events are used." })),
                scope: Type.Optional(Type.String({ description: "Optional exact target scope. Defaults to current agent scope." })),
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to write digest candidates." })),
                max_chunks: Type.Optional(Type.Number({ description: "Maximum reflection chunks when no explicit text is provided (default: 25)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_run");
                if (runtime.ok === false)
                    return runtime.response;
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                let scope = runtime.defaultScope;
                if (typeof params.scope === "string" && params.scope.trim()) {
                    scope = params.scope.trim();
                    if (!runtime.isAccessible(scope)) {
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
export function registerDigestRecoveryTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_digest_recovery",
            label: "ClawLore Digest Recovery",
            description: "Report or schedule recovery for OpenClaw-native digest parse/retry/dead-letter chunks. Defaults to dry_run=true.",
            parameters: Type.Object({
                dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to mark chunks pending_recovery." })),
                limit: Type.Optional(Type.Number({ description: "Maximum recovery candidates to process (default: 100)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_digest_recovery");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_digest_recovery");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
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
export function registerOperatorDashboardTool(api, context) {
    api.registerTool((toolCtx) => {
        return {
            name: "scope_recall_operator_dashboard",
            label: "ClawLore Operator Dashboard",
            description: "Read-only operator dashboard summarizing SQL truth, FTS, governance cleanup, journal recovery, Experience Kernel, and vector status.",
            parameters: Type.Object({}),
            async execute(_toolCallId, _params, _signal, _onUpdate, runtimeCtx) {
                const runtime = resolveExperienceRuntime(context, toolCtx, runtimeCtx, "scope_recall_operator_dashboard");
                if (runtime.ok === false)
                    return runtime.response;
                if (!runtime.systemBypass)
                    return globalExperienceOperatorDeniedResponse("scope_recall_operator_dashboard");
                const db = await context.db();
                if (!db)
                    return { content: [{ type: "text", text: "Error: SQL truth store not available" }], isError: true };
                const dashboard = buildOperatorDashboard(db, {
                    vectorStatus: context.store.getDiagnostics?.().vectorCompanion,
                });
                const summary = dashboard.summary;
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
