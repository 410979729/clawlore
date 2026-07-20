/**
 * CLI Commands for Memory Management
 */
import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { buildOperatorDashboard } from "../operator-dashboard.js";
import { canonicalDigest } from "../release-provenance.js";
import { assessRuntimeDiagnostic, configuredRuntimeMode, } from "../runtime-diagnostic-receipt.js";
import { assessRuntimeAccessibility } from "../runtime-accessibility-diagnostic.js";
import { inspectLifecycleProjection, repairLifecycleProjection, } from "../sql-lifecycle-projection.js";
import { clampInt, collectExperienceHealth, collectNightlyDigestHealth, formatJson, getPluginVersion, recordsEqual, stableRecordEntries, writeJson } from "./cli-runtime-policy.js";
export function registerDiagnosticCommands(runtime) {
    const { program, memory, context, runSearch, getSqlDbOrThrow, parseScopeFilter, parseLimitOption, dryRunFromApplyOptions, loadKnowledgeDocs, hasTables, requireExperienceTables, } = runtime;
    memory
        .command("doctor")
        .description("Run read-only diagnostics for SQL truth, LanceDB vector companion, FTS, and scope distribution")
        .option("--json", "Output as JSON")
        .option("--clean-json", "Plugin-side clean JSON mode; use with --json under the OpenClaw wrapper")
        .option("--quiet", "Plugin-side quiet JSON mode; use with --json under the OpenClaw wrapper")
        .option("--principal <platform:account:principal>", "Verify runtime visibility for one exact canonical principal")
        .option("--agent-id <id>", "Agent scope to evaluate for legacy migration debt", "main")
        .action(async (options) => {
        try {
            const stats = await context.store.stats();
            await context.store.verifyFilePrivacy();
            const scopeStats = context.scopeManager.getStats();
            const diagnostics = context.store.getDiagnostics();
            const vectorDrift = await context.store.getVectorCompanionDriftReport();
            const vectorScopeCounts = await context.store.getVectorScopeCounts();
            const sqlDb = await context.store.getSqlTruthDb();
            const experience = collectExperienceHealth(sqlDb);
            const nightlyDigest = collectNightlyDigestHealth(sqlDb);
            const sqlVectorScopeMatch = recordsEqual(stats.scopeCounts, vectorScopeCounts);
            const scopeWarnings = Object.entries(stats.scopeCounts)
                .filter(([scope]) => scope === "global" || scope.trim().length === 0)
                .map(([scope, count]) => ({ scope, count }));
            const runtimeAccessibility = assessRuntimeAccessibility({
                scopeCounts: stats.scopeCounts,
                lifecycleScopeCounts: stats.lifecycleScopeCounts,
                agentId: options.agentId,
                principalIsolation: context.pluginConfig?.principalIsolation,
                principalKey: options.principal,
            });
            const runtimeDiagnostic = await assessRuntimeDiagnostic({
                file: context.runtimeDiagnosticFile,
                configuredMode: configuredRuntimeMode(context.pluginConfig),
                configDigest: canonicalDigest(context.pluginConfig ?? {}),
            });
            const deprecatedAutoBackupEnabled = context.pluginConfig?.autoBackup === true;
            const issues = [];
            if (!diagnostics.sqlTruth.available) {
                issues.push(`SQL truth unavailable${diagnostics.sqlTruth.error ? `: ${diagnostics.sqlTruth.error}` : ""}`);
            }
            if (diagnostics.sqlTruth.fts && !diagnostics.sqlTruth.fts.healthy) {
                issues.push(`SQL truth FTS needs repair: ${diagnostics.sqlTruth.fts.reason ?? "unknown"}`);
            }
            if (stats.lifecycleProjection && !stats.lifecycleProjection.ok) {
                issues.push(`Lifecycle projection needs explicit repair: ${stats.lifecycleProjection.reason}; run clawlore repair-lifecycle-projection --apply`);
            }
            if (diagnostics.vectorCompanion.needsRepair) {
                issues.push(`Vector companion needs repair: ${diagnostics.vectorCompanion.message ?? "unknown"}`);
            }
            if (vectorDrift.missingVectorRows > 0) {
                issues.push(`Missing vector rows: ${vectorDrift.missingVectorRows}`);
            }
            if (vectorDrift.staleVectorRows > 0) {
                issues.push(`Stale vector rows: ${vectorDrift.staleVectorRows}`);
            }
            if (!sqlVectorScopeMatch) {
                issues.push("SQL truth and vector companion scope distributions differ");
            }
            if (scopeWarnings.length > 0) {
                issues.push(`Scope warning: ${scopeWarnings.map((item) => `${item.scope}:${item.count}`).join(", ")}`);
            }
            if (runtimeAccessibility.blocking) {
                issues.push(`Runtime accessibility ${runtimeAccessibility.status}: ${runtimeAccessibility.legacy.migrationDebtRows} legacy rows in ${runtimeAccessibility.legacy.scope}`);
            }
            if (!runtimeDiagnostic.ok) {
                issues.push(`Runtime diagnostic blocked: ${runtimeDiagnostic.issues.join(", ")}`);
            }
            if (deprecatedAutoBackupEnabled) {
                issues.push("Deprecated autoBackup=true does not create backups; use the encrypted snapshot/export operator flow");
            }
            if (experience.status !== "ready") {
                issues.push(`Experience Kernel ${experience.status}`);
            }
            const nativeDigest = (nightlyDigest.native || {});
            if (nativeDigest.status === "needs_recovery") {
                issues.push("OpenClaw-native digest needs recovery");
            }
            const summary = {
                ok: issues.length === 0,
                issues,
                sqlTruth: diagnostics.sqlTruth,
                lifecycleProjection: stats.lifecycleProjection,
                fts: diagnostics.fts,
                vectorCompanion: {
                    ...diagnostics.vectorCompanion,
                    drift: vectorDrift,
                },
                scopes: {
                    configured: scopeStats,
                    sqlTruthCounts: stats.scopeCounts,
                    sqlTruthLifecycleCounts: stats.lifecycleScopeCounts,
                    vectorCounts: vectorScopeCounts,
                    sqlVectorScopeMatch,
                    warnings: scopeWarnings,
                },
                runtimeAccessibility,
                runtimeDiagnostic,
                configuration: { deprecatedAutoBackupEnabled },
                categories: stats.categoryCounts,
                experience,
                nightlyDigest,
            };
            if (options.json || options.cleanJson || options.quiet) {
                writeJson(summary);
                if (!summary.ok)
                    process.exitCode = 1;
                return;
            }
            console.log("ClawLore Doctor:");
            console.log(`• Status: ${summary.ok ? "ok" : "issues found"}`);
            console.log(`• SQL truth: ${diagnostics.sqlTruth.available ? `${diagnostics.sqlTruth.count} rows` : "unavailable"}`);
            console.log(`• FTS: ${diagnostics.sqlTruth.fts?.healthy ? "healthy" : "needs repair or unavailable"}`);
            console.log(`• Lifecycle projection: ${stats.lifecycleProjection?.status ?? "unavailable"}`);
            console.log(`• Vector backend: ${diagnostics.vectorCompanion.backend}`);
            console.log(`• Vector dimension: ${diagnostics.vectorCompanion.configuredDimension}`);
            console.log(`• Vector rows: ${vectorDrift.vectorRows}`);
            console.log(`• Missing vector rows: ${vectorDrift.missingVectorRows}`);
            console.log(`• Stale vector rows: ${vectorDrift.staleVectorRows}`);
            console.log(`• Scope distribution match: ${sqlVectorScopeMatch ? "yes" : "no"}`);
            console.log(`• Runtime accessibility: ${runtimeAccessibility.status}`);
            console.log(`• Legacy migration debt: ${runtimeAccessibility.legacy.migrationDebtRows} rows`);
            if (runtimeAccessibility.principal) {
                console.log(`• Principal-visible rows: ${runtimeAccessibility.principal.visibleRows}`);
            }
            console.log(`• Runtime registration: ${runtimeDiagnostic.status}`);
            console.log(`• Deprecated autoBackup requested: ${deprecatedAutoBackupEnabled ? "yes (unsupported)" : "no"}`);
            console.log(`• Experience Kernel: ${String(experience.status)}`);
            if (experience.status === "ready") {
                const playbooks = experience.playbooks;
                const runs = experience.runs;
                console.log(`• Experience playbooks: ${playbooks?.total ?? 0}`);
                console.log(`• Experience runs: ${runs?.total ?? 0}`);
            }
            console.log(`• Nightly digest: ${String(nightlyDigest.status)}`);
            if (nativeDigest.status) {
                console.log(`• OpenClaw-native digest: ${String(nativeDigest.status)}`);
            }
            if (vectorDrift.repairHint) {
                console.log(`• Repair hint: ${vectorDrift.repairHint}`);
            }
            console.log();
            console.log("SQL truth scopes:");
            for (const [scope, count] of stableRecordEntries(stats.scopeCounts)) {
                console.log(`  • ${scope}: ${count}`);
            }
            console.log();
            console.log("Vector scopes:");
            for (const [scope, count] of stableRecordEntries(vectorScopeCounts)) {
                console.log(`  • ${scope}: ${count}`);
            }
            if (issues.length > 0) {
                console.log();
                console.log("Issues:");
                for (const issue of issues)
                    console.log(`  • ${issue}`);
                process.exitCode = 1;
            }
        }
        catch (error) {
            const diagnostics = context.store.getDiagnostics();
            const code = diagnostics.sqlTruth.errorCode ?? "DOCTOR_FAILED";
            const summary = {
                ok: false,
                issues: [code],
                recovery: "Restore or repair memory.sqlite3, then rerun clawlore doctor before enabling memory operations.",
                sqlTruth: diagnostics.sqlTruth,
            };
            console.error(`clawlore doctor ${code}: ${diagnosticErrorSummary(error)}`);
            if (options.json || options.cleanJson || options.quiet) {
                writeJson(summary);
            }
            else {
                console.log("ClawLore Doctor:");
                console.log("• Status: fail-closed");
                console.log(`• Error code: ${code}`);
                console.log(`• Recovery: ${summary.recovery}`);
            }
            process.exitCode = 1;
        }
    });
    memory
        .command("repair-lifecycle-projection")
        .description("Inspect or explicitly rebuild the auxiliary lifecycle projection from SQL truth")
        .option("--apply", "Rebuild auxiliary lifecycle tables. Default is dry-run")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const before = inspectLifecycleProjection(db);
            const dryRun = options.apply !== true;
            const after = dryRun ? before : repairLifecycleProjection(db);
            const result = {
                ok: after.ok,
                dry_run: dryRun,
                source_of_truth: "memory_truth",
                before,
                after,
            };
            if (options.json) {
                writeJson(result);
            }
            else {
                console.log("Lifecycle Projection Repair:");
                console.log(`• Mode: ${dryRun ? "dry-run" : "apply"}`);
                console.log(`• Before: ${before.status}`);
                console.log(`• After: ${after.status}`);
                console.log(`• SQL truth rows: ${after.truthRows}`);
                console.log(`• Projected rows: ${after.projectedRows}`);
            }
            if (!after.ok)
                process.exitCode = 1;
        }
        catch (error) {
            console.error(`Lifecycle projection repair failed: ${diagnosticErrorSummary(error)}`);
            process.exitCode = 1;
        }
    });
    memory
        .command("repair-vectors")
        .description("Repair the vector companion from SQL truth")
        .option("--batch-size <n>", "Embedding batch size", "32")
        .option("--limit <n>", "Limit rows to rebuild (for testing)")
        .option("--apply", "Apply vector companion writes. Default is dry-run")
        .option("--dry-run", "Show what would be rebuilt without writing; wins over --apply")
        .option("--full", "Rebuild all vector rows instead of only missing/stale rows")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            if (!context.embedder) {
                console.error("Vector repair requires an embedder (not available in basic CLI mode).");
                process.exit(1);
            }
            const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
            const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1_000_000) : undefined;
            const dryRun = options.dryRun === true || options.apply !== true;
            const result = await context.store.rebuildVectorCompanion(context.embedder, {
                batchSize,
                limit,
                dryRun,
                fullRebuild: options.full === true,
            });
            if (options.json) {
                console.log(formatJson(result));
                if (result.errors.length > 0)
                    process.exit(1);
                return;
            }
            console.log(`Vector Companion Repair:`);
            console.log(`• Mode: ${result.dryRun ? "dry-run" : "write"}`);
            console.log(`• Scope: ${result.fullRebuild ? "full rebuild" : "incremental missing/stale repair"}`);
            console.log(`• SQL truth rows: ${result.truthCount}`);
            console.log(`• Vector rows before: ${result.vectorRowsBefore}`);
            console.log(`• Processed: ${result.processed}`);
            console.log(`• ${result.dryRun ? "Would rebuild" : "Rebuilt"}: ${result.rebuilt}`);
            console.log(`• Skipped: ${result.skipped}`);
            console.log(`• Stale vector rows ${result.dryRun ? "that would be deleted" : "deleted"}: ${result.staleVectorRowsDeleted}`);
            if (limit !== undefined) {
                console.log(`• Limit: ${limit} (stale-vector pruning disabled while limited)`);
            }
            if (result.errors.length > 0) {
                console.log(`• Errors: ${result.errors.length}`);
                result.errors.slice(0, 5).forEach((error) => console.log(`  - ${error}`));
                if (result.errors.length > 5) {
                    console.log(`  ... and ${result.errors.length - 5} more`);
                }
                process.exit(1);
            }
        }
        catch (error) {
            console.error(`Vector repair failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    memory
        .command("dashboard")
        .description("Render the ClawLore operator dashboard")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const dashboard = buildOperatorDashboard(db, {
                version: getPluginVersion(),
                vectorStatus: context.store.getDiagnostics().vectorCompanion,
            });
            if (options.json) {
                writeJson(dashboard);
                return;
            }
            const summary = dashboard.summary;
            console.log("ClawLore Operator Dashboard:");
            console.log(`• Memories: ${summary.memory_rows}`);
            console.log(`• FTS: ${summary.fts_status}`);
            console.log(`• Governance cleanup candidates: ${summary.governance_cleanup_candidates}`);
            console.log(`• Memory candidate debt: ${summary.memory_candidate_debt}`);
            console.log(`• Graph hygiene: ${summary.graph_hygiene_status}`);
            console.log(`• Journal recovery: ${summary.journal_recovery_status} (${summary.journal_replay_candidates})`);
            console.log(`• Experience Kernel: ${summary.experience_status}`);
        }
        catch (error) {
            console.error(`Dashboard failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
}
