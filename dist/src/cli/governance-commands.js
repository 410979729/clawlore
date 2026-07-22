/**
 * CLI Commands for Memory Management
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listAutoRecallTraces } from "../auto-recall-ledger.js";
import { candidateDebtReport, promoteMemoryCandidates } from "../candidate-promotion.js";
import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { digestRecoveryReport, digestReport, recoverDigestChunks, runDigestPipeline, } from "../digest-pipeline.js";
import { buildForgettingReport, runForgettingWithVectorSync } from "../forgetting.js";
import { applyCleanup, rollbackCleanupBatch } from "../governance-cleanup.js";
import { graphHygieneReport, repairGraphHygiene } from "../graph-hygiene.js";
import { recoveryReport, scheduleReplay } from "../journal-recovery.js";
import { resolvePrincipalWriteTarget } from "../principal-write-boundary.js";
import { evaluateRecallScopePolicy, scopeIdForContext } from "../scope-policy.js";
import { readOpenClawSqliteTranscript, } from "../v2/storage/openclaw-sqlite-transcript-source.js";
import { groupedCounts, tableNames, writeJson } from "./cli-runtime-policy.js";
function optionalTimestampMs(value, label) {
    if (value == null || value === "")
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer in milliseconds`);
    }
    return parsed;
}
export function registerGovernanceCommands(runtime) {
    const { program, memory, context, runSearch, getSqlDbOrThrow, parseScopeFilter, parseLimitOption, dryRunFromApplyOptions, loadKnowledgeDocs, hasTables, requireExperienceTables, } = runtime;
    const candidates = memory
        .command("candidates")
        .description("Memory candidate promotion utilities");
    candidates
        .command("report")
        .description("Preview candidate-memory promotion debt")
        .option("--limit <n>", "Maximum candidates to inspect", "1000")
        .option("--sample-limit <n>", "Maximum redacted samples to include", "8")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = candidateDebtReport(db, {
                limit: parseLimitOption(options.limit, 1000),
                sampleLimit: parseLimitOption(options.sampleLimit, 8, 50),
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            const byAction = (result.by_action || {});
            console.log("Memory Candidate Promotion Report:");
            console.log(`• Status: ${result.status}`);
            console.log(`• Candidates: ${result.candidate_count}`);
            console.log(`• Promote: ${byAction.promote ?? 0}`);
            console.log(`• Archive: ${byAction.archive ?? 0}`);
            console.log(`• Keep candidate: ${byAction.keep_candidate ?? 0}`);
        }
        catch (error) {
            console.error(`Candidate report failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    candidates
        .command("apply")
        .description("Apply safe candidate-memory promotions; use --dry-run to preview")
        .option("--dry-run", "Preview without writing SQL truth")
        .option("--archive-noise", "Also archive low-value noise candidates")
        .option("--limit <n>", "Maximum candidates to process", "1000")
        .option("--batch-id <id>", "Optional governance audit batch id")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = promoteMemoryCandidates(db, {
                dryRun: options.dryRun === true,
                archiveNoise: options.archiveNoise === true,
                limit: parseLimitOption(options.limit, 1000),
                batchId: typeof options.batchId === "string" && options.batchId.trim() ? options.batchId.trim() : undefined,
                actor: "clawlore:cli",
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            const mutations = (result.mutations || {});
            console.log(`Candidate Promotion ${result.dry_run ? "Preview" : "Applied"}:`);
            console.log(`• Promoted: ${mutations.promoted ?? 0}`);
            console.log(`• Archived: ${mutations.archived ?? 0}`);
            console.log(`• Kept: ${mutations.kept ?? 0}`);
            console.log(`• Batch: ${result.batch_id ?? ""}`);
        }
        catch (error) {
            console.error(`Candidate promotion failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const digest = memory
        .command("digest")
        .description("OpenClaw-native digest and long-term memory distillation utilities");
    digest
        .command("report")
        .description("Report OpenClaw-native digest ledger, failures, and candidate debt")
        .option("--sample-limit <n>", "Maximum redacted chunk samples to include", "8")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = digestReport(db, {
                sampleLimit: parseLimitOption(options.sampleLimit, 8, 50),
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log("OpenClaw Digest Report:");
            console.log(`• Status: ${result.status}`);
            console.log(`• Candidate debt: ${result.candidate_debt ?? 0}`);
            console.log(`• Failed runs: ${result.failed_runs ?? 0}`);
        }
        catch (error) {
            console.error(`Digest report failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    digest
        .command("run")
        .description("Run OpenClaw-native digest extraction; dry-run by default")
        .option("--text <text>", "Explicit digest input text")
        .option("--input-file <path>", "Read digest input text from a file")
        .option("--transcript-db <path>", "Read one exact OpenClaw SQLite session from an owner-only database")
        .option("--transcript-session-id <id>", "Exact session id required with --transcript-db")
        .option("--transcript-since-ms <ms>", "Inclusive transcript event lower bound")
        .option("--transcript-until-ms <ms>", "Exclusive transcript event upper bound")
        .option("--principal-key <platform:account:principal>", "Exact canonical private principal")
        .option("--session-key <key>", "Exact OpenClaw private session key")
        .option("--max-chunks <n>", "Maximum reflection or eligible transcript chunks", "25")
        .option("--use-llm", "Use configured LLM extraction before heuristic fallback")
        .option("--no-llm-fallback", "Disable heuristic fallback after LLM extraction")
        .option("--apply", "Write digest candidates to SQL truth and vector companion")
        .option("--dry-run", "Preview without writing; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const dryRun = dryRunFromApplyOptions(options);
            const target = resolvePrincipalWriteTarget({
                principalKey: options.principalKey,
                sessionKey: options.sessionKey,
            });
            const textSelected = typeof options.text === "string" && options.text.trim();
            const fileSelected = typeof options.inputFile === "string" && options.inputFile.trim();
            const transcriptSelected = typeof options.transcriptDb === "string" && options.transcriptDb.trim();
            if ([textSelected, fileSelected, transcriptSelected].filter(Boolean).length > 1) {
                throw new Error("--text, --input-file, and --transcript-db are mutually exclusive");
            }
            if (!transcriptSelected && options.transcriptSessionId != null) {
                throw new Error("--transcript-session-id requires --transcript-db");
            }
            let inputText = textSelected ? options.text : undefined;
            if (fileSelected) {
                inputText = await readFile(path.resolve(options.inputFile.trim()), "utf8");
            }
            const maxChunks = parseLimitOption(options.maxChunks, 25, 200);
            let transcriptInspection;
            let inputChunks;
            if (transcriptSelected) {
                if (typeof options.transcriptSessionId !== "string" || !options.transcriptSessionId.trim()) {
                    throw new Error("--transcript-session-id is required with --transcript-db");
                }
                const transcript = readOpenClawSqliteTranscript({
                    dbPath: options.transcriptDb,
                    sessionId: options.transcriptSessionId,
                    scope: target.scope,
                    startMs: optionalTimestampMs(options.transcriptSinceMs, "--transcript-since-ms"),
                    endMs: optionalTimestampMs(options.transcriptUntilMs, "--transcript-until-ms"),
                    maxEvents: maxChunks,
                });
                inputChunks = transcript.chunks;
                transcriptInspection = transcript.inspection;
            }
            const result = await runDigestPipeline(db, {
                apply: !dryRun,
                scope: target.scope,
                inputText,
                inputChunks,
                sourceId: typeof options.inputFile === "string" && options.inputFile.trim()
                    ? "cli-file"
                    : inputText
                        ? "cli-text"
                        : undefined,
                sourceType: transcriptSelected
                    ? "openclaw_sqlite_transcript"
                    : inputText
                        ? "explicit"
                        : "reflection_event",
                maxChunks,
                useLlm: options.useLlm === true,
                llmFallback: options.llmFallback !== false,
                llmClient: context.llmClient,
                store: context.store,
                embedPassage: context.embedder
                    ? (text) => context.embedder.embedPassage(text)
                    : undefined,
                actor: "clawlore:cli",
            });
            if (options.json) {
                writeJson(transcriptInspection ? { ...result, transcript_source: transcriptInspection } : result);
                if (!result.ok)
                    process.exitCode = 1;
                return;
            }
            console.log(`OpenClaw Digest ${result.dry_run ? "Preview" : "Run"}:`);
            console.log(`• Status: ${result.status}`);
            console.log(`• Chunks: ${result.source.chunks_seen}`);
            console.log(`• Extracted: ${result.extracted}`);
            console.log(`• Stored candidates: ${result.stored}`);
            console.log(`• Skipped: ${result.skipped}`);
            if (transcriptInspection) {
                console.log(`• Transcript source: read-only exact session`);
                console.log(`• Eligible transcript events: ${transcriptInspection.eligibleEvents}`);
            }
            if (result.errors.length > 0) {
                console.log(`• Errors: ${result.errors.length}`);
                process.exitCode = 1;
            }
        }
        catch (error) {
            console.error(`Digest run failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    digest
        .command("recovery")
        .description("Report or schedule retry for digest parse/retry/dead-letter chunks")
        .option("--limit <n>", "Maximum recovery candidates to inspect", "100")
        .option("--apply", "Mark recoverable chunks as pending_recovery")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const dryRun = dryRunFromApplyOptions(options);
            const result = dryRun
                ? { ...digestRecoveryReport(db, { limit: parseLimitOption(options.limit, 100, 500) }), dry_run: true }
                : recoverDigestChunks(db, {
                    dryRun: false,
                    limit: parseLimitOption(options.limit, 100, 500),
                    actor: "clawlore:cli",
                });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`OpenClaw Digest Recovery ${dryRun ? "Preview" : "Scheduled"}:`);
            console.log(`• Status: ${result.status}`);
            console.log(`• Candidates: ${result.candidate_count ?? 0}`);
            if ("recovered" in result)
                console.log(`• Recovered: ${result.recovered}`);
        }
        catch (error) {
            console.error(`Digest recovery failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const governance = memory
        .command("governance")
        .description("Governance cleanup and audit utilities");
    governance
        .command("cleanup")
        .description("Soft-archive historical template/transcript-shaped memory rows; dry-run by default")
        .option("--scope <scope...>", "Restrict cleanup to scope(s); repeat or comma-separate")
        .option("--limit <n>", "Maximum candidates to process", "500")
        .option("--batch-id <id>", "Optional cleanup batch id")
        .option("--apply", "Apply soft archive writes")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = applyCleanup(db, {
                scopeFilter: parseScopeFilter(options.scope),
                dryRun: dryRunFromApplyOptions(options),
                limit: parseLimitOption(options.limit, 500),
                batchId: typeof options.batchId === "string" && options.batchId.trim() ? options.batchId.trim() : undefined,
                actor: "clawlore:cli",
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`Governance Cleanup ${result.dry_run ? "Preview" : "Applied"}:`);
            console.log(`• Candidates: ${result.candidate_count}`);
            console.log(`• Archived: ${result.archived}`);
            console.log(`• Batch: ${result.batch_id}`);
        }
        catch (error) {
            console.error(`Governance cleanup failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    governance
        .command("rollback")
        .description("Roll back a previous governance cleanup batch; dry-run by default")
        .requiredOption("--batch-id <id>", "Cleanup batch id to roll back")
        .option("--apply", "Apply rollback writes")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = rollbackCleanupBatch(db, {
                batchId: String(options.batchId),
                dryRun: dryRunFromApplyOptions(options),
                actor: "clawlore:cli",
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`Governance Rollback ${result.dry_run ? "Preview" : "Applied"}:`);
            console.log(`• Candidates: ${result.rollback_candidates}`);
            console.log(`• Restored: ${result.restored}`);
            console.log(`• Batch: ${result.batch_id}`);
        }
        catch (error) {
            console.error(`Governance rollback failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    governance
        .command("audit-coverage")
        .description("Report governance audit event coverage")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const tables = tableNames(db);
            const payload = {
                status: tables.has("governance_audit_events") ? "ready" : "missing",
                audit_events: 0,
                by_event_type: {},
                by_action: {},
                archived_rows_with_batch: 0,
            };
            if (tables.has("governance_audit_events")) {
                payload.audit_events = Number(db.prepare("SELECT COUNT(*) AS count FROM governance_audit_events").get()?.count || 0);
                payload.by_event_type = groupedCounts(db, "SELECT event_type AS key, COUNT(*) AS count FROM governance_audit_events GROUP BY event_type");
                payload.by_action = groupedCounts(db, "SELECT action AS key, COUNT(*) AS count FROM governance_audit_events GROUP BY action");
            }
            if (tables.has("memory_truth")) {
                payload.archived_rows_with_batch = Number(db.prepare(`
              SELECT COUNT(*) AS count
              FROM memory_truth
              WHERE json_valid(metadata)
                AND (
                  COALESCE(json_extract(metadata, '$.rollback_batch_id'), '') != ''
                  OR COALESCE(json_extract(metadata, '$.candidate_promotion_batch_id'), '') != ''
                )
            `).get()?.count || 0);
            }
            if (options.json) {
                writeJson(payload);
                return;
            }
            console.log("Governance Audit Coverage:");
            console.log(`• Status: ${payload.status}`);
            console.log(`• Audit events: ${payload.audit_events}`);
            console.log(`• Archived rows with batch: ${payload.archived_rows_with_batch}`);
        }
        catch (error) {
            console.error(`Governance audit coverage failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const journal = memory
        .command("journal")
        .description("Journal recovery utilities");
    journal
        .command("recovery")
        .description("Report or schedule replay for retry-exhausted/dead-letter journal entries")
        .option("--include-dead-letter", "Include dead-letter:* rows as replay candidates")
        .option("--limit <n>", "Maximum candidates to process", "500")
        .option("--batch-id <id>", "Optional governance audit batch id")
        .option("--apply", "Schedule replay writes")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const reasonPrefixes = options.includeDeadLetter === true
                ? ["retry-exhausted:", "dead-letter:"]
                : ["retry-exhausted:"];
            const dryRun = dryRunFromApplyOptions(options);
            const result = dryRun
                ? { ...recoveryReport(db, { reasonPrefixes, limit: parseLimitOption(options.limit, 500) }), dry_run: true }
                : scheduleReplay(db, {
                    reasonPrefixes,
                    limit: parseLimitOption(options.limit, 500),
                    dryRun: false,
                    batchId: typeof options.batchId === "string" && options.batchId.trim() ? options.batchId.trim() : undefined,
                    actor: "clawlore:cli",
                });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`Journal Recovery ${dryRun ? "Preview" : "Applied"}:`);
            console.log(`• Status: ${result.status}`);
            console.log(`• Candidates: ${result.candidate_count}`);
            if ("scheduled" in result)
                console.log(`• Scheduled: ${result.scheduled}`);
        }
        catch (error) {
            console.error(`Journal recovery failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const graph = memory
        .command("graph")
        .description("Graph companion hygiene utilities");
    graph
        .command("hygiene")
        .description("Report or repair rebuildable graph companion hygiene; dry-run by default")
        .option("--apply", "Apply graph companion cleanup")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const dryRun = dryRunFromApplyOptions(options);
            const result = dryRun
                ? { ...graphHygieneReport(db), dry_run: true }
                : repairGraphHygiene(db, { dryRun: false });
            if (options.json) {
                writeJson(result);
                return;
            }
            const counts = (result.counts || (result.before?.counts) || {});
            console.log(`Graph Hygiene ${dryRun ? "Report" : "Applied"}:`);
            console.log(`• Status: ${result.status}`);
            console.log(`• Orphan entities: ${counts.orphan_entities ?? 0}`);
            console.log(`• Orphan relations: ${counts.orphan_relations ?? 0}`);
        }
        catch (error) {
            console.error(`Graph hygiene failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const forgetting = memory
        .command("forgetting")
        .description("Forgetting and cleanup utilities");
    forgetting
        .command("report")
        .description("Preview soft-archive and hard-delete forgetting candidates")
        .option("--scope <scope...>", "Restrict report to scope(s); repeat or comma-separate")
        .option("--limit <n>", "Maximum candidates to include", "200")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = buildForgettingReport(db, {
                scopeFilter: parseScopeFilter(options.scope),
                limit: parseLimitOption(options.limit, 200),
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log("Forgetting Report:");
            console.log(`• Active rows: ${result.active_rows}/${result.total_rows}`);
            console.log(`• Soft archive candidates: ${result.soft_archive_candidates.count}`);
            console.log(`• Hard delete candidates: ${result.hard_delete_candidates.count}`);
            console.log(`• Duplicate groups: ${result.duplicate_groups.count}`);
        }
        catch (error) {
            console.error(`Forgetting report failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    forgetting
        .command("run")
        .description("Run forgetting cleanup; dry-run by default")
        .option("--scope <scope...>", "Restrict cleanup to scope(s); repeat or comma-separate")
        .option("--limit <n>", "Maximum candidates to process", "200")
        .option("--hard-delete-sensitive", "Allow sensitive hard-delete candidates; requires vector sync callback for writes")
        .option("--apply", "Apply SQL truth writes")
        .option("--dry-run", "Preview only; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = await runForgettingWithVectorSync(db, {
                scopeFilter: parseScopeFilter(options.scope),
                limit: parseLimitOption(options.limit, 200),
                hardDeleteSensitive: options.hardDeleteSensitive === true,
                dryRun: dryRunFromApplyOptions(options),
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`Forgetting ${result.dry_run ? "Preview" : "Applied"}:`);
            console.log(`• Archived: ${result.archived}`);
            console.log(`• Deleted: ${result.deleted}`);
            if (result.hard_delete_blocked)
                console.log(`• Hard delete blocked: ${result.blocked_reason}`);
        }
        catch (error) {
            console.error(`Forgetting run failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    memory
        .command("recall-trace")
        .description("List read-only auto-recall trace ledger entries")
        .option("--scope <scope>", "Optional scope id")
        .option("--limit <n>", "Maximum trace rows", "20")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const result = listAutoRecallTraces(db, {
                scope_id: typeof options.scope === "string" ? options.scope : undefined,
                limit: parseLimitOption(options.limit, 20, 500),
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            console.log(`Auto Recall Trace Ledger: ${result.status}`);
            console.log(`• Total: ${result.total}`);
            console.log(`• Cross-scope refs in listed rows: ${result.totals.crossed_scope}`);
            for (const item of result.items.slice(0, 10)) {
                console.log(`• ${item.created_at} [${item.decision}] injected=${item.injected_count} reason=${item.reason || "none"}`);
            }
        }
        catch (error) {
            console.error(`Auto recall trace listing failed: ${diagnosticErrorSummary(error)}`);
            process.exit(1);
        }
    });
    const scopePolicy = memory
        .command("scope-policy")
        .description("Evaluate explicit recall scope policy decisions");
    scopePolicy
        .command("evaluate")
        .description("Evaluate whether a candidate scope crosses the current recall boundary")
        .option("--current-scope <scope>", "Current scope id")
        .requiredOption("--candidate-scope <scope>", "Candidate memory scope id")
        .option("--agent <agent>", "Agent id used when current scope is omitted")
        .option("--project <project>", "Project id used when current scope is omitted")
        .option("--channel <channel>", "Channel id used when current scope is omitted")
        .option("--customer-host <host>", "Customer host used when current scope is omitted")
        .option("--task-class <class>", "Task class used when current scope is omitted")
        .option("--allow-cross-scope", "Explicitly allow cross-scope injection")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        const currentScope = typeof options.currentScope === "string" && options.currentScope.trim()
            ? options.currentScope
            : scopeIdForContext({
                agent_id: typeof options.agent === "string" ? options.agent : undefined,
                project_id: typeof options.project === "string" ? options.project : undefined,
                channel_id: typeof options.channel === "string" ? options.channel : undefined,
                customer_host: typeof options.customerHost === "string" ? options.customerHost : undefined,
                task_class: typeof options.taskClass === "string" ? options.taskClass : undefined,
            });
        const result = evaluateRecallScopePolicy({
            current_scope: currentScope,
            candidate_scope: String(options.candidateScope),
            allow_cross_scope: options.allowCrossScope === true,
        });
        if (options.json) {
            writeJson(result);
            return;
        }
        console.log(`Scope Policy: ${result.label}`);
        console.log(`• Injectable: ${result.injectable ? "yes" : "no"}`);
        console.log(`• Reason: ${result.reason}`);
    });
}
