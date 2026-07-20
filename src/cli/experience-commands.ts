/**
 * CLI Commands for Memory Management
 */

import JSON5 from "json5";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { buildExperienceDebtReport } from "../experience-governance.js";
import { runPromotionBatch } from "../experience-promotion-batch.js";
import { promoteExperiences } from "../experience-promotion.js";
import { loadReplayCases, runReplaySuite } from "../experience-replay.js";
import {
  ensureExperienceSchema,
  getExperienceStats,
  reviewPlaybook,
  searchPlaybooks,
} from "../experience-store.js";
import {
  buildKnowledgeSkillDrafts
} from "../knowledge-skill-bridge.js";
import { verifyPrivatePath, writePrivateFileAtomic } from "../file-privacy.js";
import { isMemoryEntrySafeForEgress } from "../memory-egress-policy.js";
import { type MemoryEntry } from "../store.js";

import {
  type CliRegistrationContext,
  formatJson,
  writeJson
} from "./cli-runtime-policy.js";


export function registerExperienceCommands(runtime: CliRegistrationContext): void {
  const {
    program,
    memory,
    context,
    runSearch,
    getSqlDbOrThrow,
    parseScopeFilter,
    parseLimitOption,
    dryRunFromApplyOptions,
    loadKnowledgeDocs,
    hasTables,
    requireExperienceTables,
  } = runtime;
  const experience = memory
    .command("experience")
    .description("Experience Kernel utilities");

  experience
    .command("stats")
    .description("Show Experience Kernel stats")
    .option("--scope <scope>", "Optional scope id")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        if (!requireExperienceTables(db)) {
          const payload = { status: "schema_missing", message: "Experience Kernel tables are not initialized" };
          if (options.json) writeJson(payload);
          else console.log("Experience Kernel tables are not initialized.");
          return;
        }
        const result = getExperienceStats(db, typeof options.scope === "string" ? options.scope : undefined);
        if (options.json) {
          writeJson(result);
          return;
        }
        console.log("Experience Kernel Stats:");
        console.log(`• Episodes: ${result.episodes.total}`);
        console.log(`• Playbooks: ${result.playbooks.total}`);
        console.log(`• Runs: ${result.runs.total}`);
      } catch (error) {
        console.error(`Experience stats failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  experience
    .command("debt")
    .description("Show read-only Experience governance debt")
    .option("--scope <scope>", "Optional scope id")
    .option("--limit <n>", "Maximum items per debt class", "20")
    .option("--stale-days <n>", "Candidate age threshold in days", "14")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        ensureExperienceSchema(db);
        const result = buildExperienceDebtReport(db, {
          scope_id: typeof options.scope === "string" ? options.scope : undefined,
          limit: parseLimitOption(options.limit, 20, 200),
          stale_candidate_days: parseLimitOption(options.staleDays, 14, 3650),
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        if (result.status === "schema_missing") {
          console.log(`Experience governance debt: ${result.status}`);
          console.log(`• Missing tables: ${(result.missing_tables ?? []).join(", ")}`);
          return;
        }
        console.log(`Experience Governance Debt: ${result.status}`);
        console.log(`• Ready to promote episodes: ${result.debt.ready_to_promote_episodes.count}`);
        console.log(`• Blocked successful episodes: ${result.debt.blocked_success_episodes.count}`);
        console.log(`• Review backlog playbooks: ${result.debt.review_backlog_playbooks.count}`);
        console.log(`• Stale candidate playbooks: ${result.debt.stale_candidate_playbooks.count}`);
        console.log(`• Failing playbooks: ${result.debt.failing_playbooks.count}`);
        for (const recommendation of result.recommendations) {
          console.log(`• ${recommendation.kind}: ${recommendation.action}`);
        }
      } catch (error) {
        console.error(`Experience debt report failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  experience
    .command("promote")
    .description("Extract reusable playbooks from successful task episodes; dry-run by default")
    .option("--scope <scope>", "Optional scope id")
    .option("--max-episodes <n>", "Maximum episodes to scan", "50")
    .option("--apply", "Create/promote playbooks")
    .option("--dry-run", "Preview only; wins over --apply")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        ensureExperienceSchema(db);
        const result = promoteExperiences(db, {
          scope_id: typeof options.scope === "string" ? options.scope : undefined,
          dry_run: dryRunFromApplyOptions(options),
          config: {
            max_episodes: parseLimitOption(options.maxEpisodes, 50, 500),
          },
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        console.log(`Experience Promotion ${result.dry_run ? "Preview" : "Applied"}:`);
        console.log(`• Episodes scanned: ${result.episodes_scanned}`);
        console.log(`• Playbooks created: ${result.playbooks_created}`);
        console.log(`• Playbooks promoted: ${result.playbooks_promoted}`);
        console.log(`• Needs review: ${result.playbooks_needing_review}`);
      } catch (error) {
        console.error(`Experience promotion failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  experience
    .command("promotion-batch")
    .description("Run a controlled promotion batch with dry-run default and apply ledger")
    .option("--scope <scope>", "Optional scope id")
    .option("--max-episodes <n>", "Maximum episodes to scan", "50")
    .option("--reviewer-note <note>", "Reviewer note to store with an applied batch")
    .option("--requested-by <name>", "Operator name or automation id", "clawlore:cli")
    .option("--apply", "Apply promotion and record the batch")
    .option("--dry-run", "Preview only; wins over --apply")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        const result = runPromotionBatch(db, {
          scope_id: typeof options.scope === "string" ? options.scope : undefined,
          max_episodes: parseLimitOption(options.maxEpisodes, 50, 500),
          dry_run: dryRunFromApplyOptions(options),
          reviewer_note: typeof options.reviewerNote === "string" ? options.reviewerNote : "",
          requested_by: typeof options.requestedBy === "string" ? options.requestedBy : "clawlore:cli",
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        console.log(`Experience Promotion Batch ${result.dry_run ? "Preview" : "Applied"}:`);
        console.log(`• Batch id: ${result.batch_id}`);
        console.log(`• Recorded: ${result.recorded ? "yes" : "no"}`);
        console.log(`• Episodes scanned: ${result.promotion.episodes_scanned}`);
        console.log(`• Playbooks created: ${result.promotion.playbooks_created}`);
        console.log(`• Playbooks promoted: ${result.promotion.playbooks_promoted}`);
        console.log(`• Needs review: ${result.promotion.playbooks_needing_review}`);
        if (!result.dry_run) console.log(`• Backup hint: ${result.backup_hint}`);
      } catch (error) {
        console.error(`Experience promotion batch failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  experience
    .command("bridge-drafts")
    .description("Generate reviewed knowledge/skill draft candidates without writing human truth")
    .option("--scope <scope>", "Optional scope id")
    .option("--target <kind>", "knowledge, skill, or both", "both")
    .option("--limit <n>", "Maximum playbooks to inspect", "20")
    .option("--knowledge-dir <path>", "Optional knowledge directory for dedupe")
    .option("--apply", "Record draft rows in SQL; does not write Markdown or apply skills")
    .option("--dry-run", "Preview only; wins over --apply")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        ensureExperienceSchema(db);
        const docs = await loadKnowledgeDocs(options.knowledgeDir, 80);
        const requestedTarget = String(options.target || "both");
        const target = requestedTarget === "knowledge" || requestedTarget === "skill"
          ? requestedTarget
          : "both";
        const result = buildKnowledgeSkillDrafts(db, {
          scope_id: typeof options.scope === "string" ? options.scope : undefined,
          target,
          limit: parseLimitOption(options.limit, 20, 200),
          existing_docs: docs,
          record: !dryRunFromApplyOptions(options),
        });
        if (options.json) {
          writeJson({ ...result, knowledge_docs_scanned: docs.length });
          return;
        }
        console.log(`Experience Bridge Drafts ${result.dry_run ? "Preview" : "Recorded"}:`);
        console.log(`• Drafts: ${result.count}`);
        console.log(`• Knowledge docs scanned: ${docs.length}`);
        for (const draft of result.drafts.slice(0, 10)) {
          console.log(`• ${draft.target_kind}: ${draft.title} -> ${draft.draft_path_hint}`);
        }
      } catch (error) {
        console.error(`Experience bridge draft generation failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  experience
    .command("replay")
    .description("Run Experience replay fixture cases against a playbook")
    .requiredOption("--playbook-id <id>", "Playbook id to replay")
    .option("--cases <path>", "Replay cases JSON file", "benchmarks/experience-replay-cases.json")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        if (!requireExperienceTables(db)) {
          const payload = { status: "schema_missing", message: "Experience Kernel tables are not initialized" };
          if (options.json) writeJson(payload);
          else console.log("Experience Kernel tables are not initialized.");
          return;
        }
        const casesPath = path.resolve(String(options.cases || "benchmarks/experience-replay-cases.json"));
        const raw = JSON5.parse(await readFile(casesPath, "utf8"));
        const cases = loadReplayCases(Array.isArray(raw) ? raw : raw.cases);
        const result = runReplaySuite(db, String(options.playbookId), cases);
        const payload = {
          status: result.failed === 0 ? "ok" : "failed",
          playbook_id: String(options.playbookId),
          cases_file: casesPath,
          ...result,
        };
        if (options.json) {
          writeJson(payload);
          return;
        }
        console.log(`Experience Replay: ${payload.status}`);
        console.log(`• Passed: ${result.passed}/${result.total}`);
        console.log(`• Failed: ${result.failed}`);
      } catch (error) {
        console.error(`Experience replay failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  const playbooks = memory
    .command("playbooks")
    .description("Experience playbook utilities");

  playbooks
    .command("list")
    .description("List/search Experience playbooks")
    .option("--query <query>", "Optional search query")
    .option("--scope <scope...>", "Restrict to scope(s); repeat or comma-separate")
    .option("--task-class <taskClass>", "Filter by task class")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Maximum playbooks", "20")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        if (!requireExperienceTables(db)) {
          const payload = { status: "schema_missing", items: [] };
          if (options.json) writeJson(payload);
          else console.log("Experience Kernel tables are not initialized.");
          return;
        }
        const items = searchPlaybooks(db, {
          query: typeof options.query === "string" ? options.query : undefined,
          scope_ids: parseScopeFilter(options.scope),
          task_class: typeof options.taskClass === "string" ? options.taskClass : undefined,
          status: typeof options.status === "string" ? options.status : undefined,
          limit: parseLimitOption(options.limit, 20, 200),
        });
        if (options.json) {
          writeJson({ count: items.length, items });
          return;
        }
        console.log(`Playbooks: ${items.length}`);
        for (const item of items) {
          console.log(`• ${item.id} [${item.status}] ${item.title}`);
        }
      } catch (error) {
        console.error(`Playbook list failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  playbooks
    .command("review")
    .description("Review a playbook and update status")
    .requiredOption("--id <id>", "Playbook id")
    .requiredOption("--action <action>", "review, promote, needs_review, quarantine, or supersede")
    .option("--reason <reason>", "Review reason")
    .option("--superseded-by <id>", "Replacement playbook id for supersede")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        ensureExperienceSchema(db);
        const result = reviewPlaybook(db, {
          playbookId: String(options.id),
          action: String(options.action) as "review" | "promote" | "needs_review" | "quarantine" | "supersede",
          reason: typeof options.reason === "string" ? options.reason : undefined,
          supersededBy: typeof options.supersededBy === "string" ? options.supersededBy : undefined,
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        if (!result.reviewed) {
          console.error(`Playbook review failed: ${diagnosticErrorSummary(result.error)}`);
          process.exit(1);
        }
        console.log(`Playbook ${result.id} updated to ${result.status} (version ${result.version})`);
      } catch (error) {
        console.error(`Playbook review failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  for (const action of ["promote", "quarantine"] as const) {
    playbooks
      .command(action)
      .description(`${action} a playbook`)
      .requiredOption("--id <id>", "Playbook id")
      .option("--reason <reason>", "Review reason")
      .option("--json", "Output as JSON")
      .action(async (options) => {
        try {
          const db = await getSqlDbOrThrow();
          ensureExperienceSchema(db);
          const result = reviewPlaybook(db, {
            playbookId: String(options.id),
            action: action === "promote" ? "promote" : "quarantine",
            reason: typeof options.reason === "string" ? options.reason : undefined,
          });
          if (options.json) {
            writeJson(result);
            return;
          }
          if (!result.reviewed) {
            console.error(`Playbook ${action} failed: ${diagnosticErrorSummary(result.error)}`);
            process.exit(1);
          }
          console.log(`Playbook ${result.id} updated to ${result.status} (version ${result.version})`);
        } catch (error) {
          console.error(`Playbook ${action} failed: ${diagnosticErrorSummary(error)}`);
          process.exit(1);
        }
      });
  }

  playbooks
    .command("supersede")
    .description("Mark a playbook as superseded by another playbook")
    .requiredOption("--id <id>", "Playbook id")
    .requiredOption("--superseded-by <id>", "Replacement playbook id")
    .option("--reason <reason>", "Review reason")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const db = await getSqlDbOrThrow();
        ensureExperienceSchema(db);
        const result = reviewPlaybook(db, {
          playbookId: String(options.id),
          action: "supersede",
          reason: typeof options.reason === "string" ? options.reason : undefined,
          supersededBy: String(options.supersededBy),
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        if (!result.reviewed) {
          console.error(`Playbook supersede failed: ${diagnosticErrorSummary(result.error)}`);
          process.exit(1);
        }
        console.log(`Playbook ${result.id} superseded by ${options.supersededBy} (version ${result.version})`);
      } catch (error) {
        console.error(`Playbook supersede failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .action(async (id, options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const deleted = await context.store.delete(id, scopeFilter);

        if (deleted) {
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          console.log(`Memory ${id} not found or access denied.`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`Failed to delete memory: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Bulk delete
  memory
    .command("delete-bulk")
    .description("Bulk delete memories with filters")
    .option("--scope <scopes...>", "Scopes to delete from (required)")
    .option("--before <date>", "Delete memories before this date (YYYY-MM-DD)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options) => {
      try {
        if (!options.scope || options.scope.length === 0) {
          console.error("At least one scope must be specified for safety.");
          process.exit(1);
        }

        let beforeTimestamp: number | undefined;
        if (options.before) {
          const date = new Date(options.before);
          if (isNaN(date.getTime())) {
            console.error("Invalid date format. Use YYYY-MM-DD.");
            process.exit(1);
          }
          beforeTimestamp = date.getTime();
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be deleted");
          console.log(`Filters: scopes=${options.scope.join(',')}, before=${options.before || 'none'}`);

          // Show what would be deleted
          const stats = await context.store.stats(options.scope);
          console.log(`Would delete from ${stats.totalCount} memories in matching scopes.`);
        } else {
          const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
          console.log(`Deleted ${deletedCount} memories.`);
        }
      } catch (error) {
        console.error(`Bulk delete failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Export memories
  memory
    .command("export")
    .description("Export secret-safe memories to JSON")
    .option("--scope <scope>", "Export specific scope")
    .option("--category <category>", "Export specific category")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          1000 // Large limit for export
        );
        const unsafeCount = memories.reduce(
          (count, memory) => count + (isMemoryEntrySafeForEgress(memory) ? 0 : 1),
          0,
        );
        if (unsafeCount > 0) {
          throw new Error(
            `Export blocked: ${unsafeCount} memor${unsafeCount === 1 ? "y contains" : "ies contain"} secret-shaped text or metadata`,
          );
        }

        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: memories.length,
          filters: {
            scope: options.scope,
            category: options.category,
          },
          memories: memories.map(m => ({
            ...m,
            vector: undefined, // Exclude vectors to reduce size
          })),
        };

        const output = formatJson(exportData);

        if (options.output) {
          const outputPath = path.resolve(options.output);
          verifyPrivatePath(path.dirname(outputPath), { kind: "directory" });
          await writePrivateFileAtomic(outputPath, output);
          console.log(`Exported ${memories.length} memories to ${outputPath}`);
        } else {
          console.log(output);
        }
      } catch (error) {
        console.error(`Export failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Import memories
  memory
    .command("import <file>")
    .description("Import memories from JSON file")
    .option("--scope <scope>", "Import into specific scope")
    .option("--dry-run", "Show what would be imported without actually importing")
    .action(async (file, options) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(file, "utf-8");
        const data = JSON.parse(content);

        if (!data.memories || !Array.isArray(data.memories)) {
          throw new Error("Invalid import file format");
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be imported");
          console.log(`Would import ${data.memories.length} memories`);
          if (options.scope) {
            console.log(`Target scope: ${options.scope}`);
          }
          return;
        }

        console.log(`Importing ${data.memories.length} memories...`);

        let imported = 0;
        let skipped = 0;

        if (!context.embedder) {
          console.error("Import requires an embedder (not available in basic CLI mode).");
          console.error("Use the plugin's memory_store tool or pass embedder to createMemoryCLI.");
          return;
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();

        for (const memory of data.memories) {
          try {
            const text = memory.text;
            if (!text || typeof text !== "string" || text.length < 2) {
              skipped++;
              continue;
            }

            const categoryRaw = memory.category;
            const category: MemoryEntry["category"] =
              categoryRaw === "preference" ||
                categoryRaw === "fact" ||
                categoryRaw === "decision" ||
                categoryRaw === "entity" ||
                categoryRaw === "other"
                ? categoryRaw
                : "other";

            const importanceRaw = Number(memory.importance);
            const importance = Number.isFinite(importanceRaw)
              ? Math.max(0, Math.min(1, importanceRaw))
              : 0.7;

            const timestampRaw = Number(memory.timestamp);
            const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

            const metadataRaw = memory.metadata;
            const metadata =
              typeof metadataRaw === "string"
                ? metadataRaw
                : metadataRaw != null
                  ? JSON.stringify(metadataRaw)
                  : "{}";

            const idRaw = memory.id;
            const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;

            // Imported legacy rows are untrusted. Reject secret-bearing text or
            // metadata before retrieval/embedding so provider-backed lanes can
            // never receive plaintext that the final store gate would reject.
            if (!isMemoryEntrySafeForEgress({ text, metadata })) {
              skipped++;
              continue;
            }

            // Idempotency: if the import file includes an id and we already have it, skip.
            if (id && (await context.store.hasId(id))) {
              skipped++;
              continue;
            }

            // Back-compat dedupe: if no id provided, do a best-effort similarity check.
            if (!id) {
              const existing = await context.retriever.retrieve({
                query: text,
                limit: 1,
                scopeFilter: [targetScope],
              });
              if (existing.length > 0 && existing[0].score > 0.95) {
                skipped++;
                continue;
              }
            }

            const vector = await context.embedder.embedPassage(text);

            if (id) {
              await context.store.importEntry({
                id,
                text,
                vector,
                category,
                scope: targetScope,
                importance,
                timestamp,
                metadata,
              });
            } else {
              await context.store.store({
                text,
                vector,
                importance,
                category,
                scope: targetScope,
                metadata,
              });
            }

            imported++;
          } catch (error) {
            console.warn(`Failed to import memory: ${diagnosticErrorSummary(error)}`);
            skipped++;
          }
        }

        console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
      } catch (error) {
        console.error(`Import failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });
}
