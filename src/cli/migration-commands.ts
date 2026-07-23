/**
 * CLI Commands for Memory Management
 */

import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { createMemoryUpgrader } from "../memory-upgrader.js";
import { isMemoryEntrySafeForEgress, redactMemoryTextForOutput } from "../memory-egress-policy.js";
import { resolvePrincipalWriteTarget } from "../principal-write-boundary.js";
import { loadLanceDB, type MemoryEntry } from "../store.js";
import {
  collectLanceRows,
  DEFAULT_LANCE_SCAN_MAX_ROWS,
} from "../lance-row-scan.js";

import {
  clampInt,
  type CliRegistrationContext
} from "./cli-runtime-policy.js";


export function registerMigrationCommands(runtime: CliRegistrationContext): void {
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
  // Re-embed an existing LanceDB into the current target DB (A/B testing)
  memory
    .command("reembed")
    .description("Re-embed memories from a source LanceDB database into the current target database")
    .requiredOption("--source-db <path>", "Source LanceDB database directory")
    .option("--batch-size <n>", "Batch size for embedding calls", "32")
    .option("--limit <n>", "Limit number of rows to process (for testing)")
    .option("--dry-run", "Show what would be re-embedded without writing")
    .option("--skip-existing", "Skip entries whose id already exists in the target DB")
    .option("--force", "Allow using the same source-db as the target dbPath (DANGEROUS)")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("Re-embed requires an embedder (not available in basic CLI mode).");
          return;
        }
        const embedBatchPassage = context.embedder.embedBatchPassage
          ? context.embedder.embedBatchPassage.bind(context.embedder)
          : async (texts: string[]) => Promise.all(texts.map((text) => context.embedder!.embedPassage(text)));

        const fs = await import("node:fs/promises");

        const sourceDbPath = options.sourceDb as string;
        const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
        const limit = options.limit
          ? clampInt(parseInt(options.limit, 10) || 0, 1, DEFAULT_LANCE_SCAN_MAX_ROWS)
          : undefined;
        const dryRun = options.dryRun === true;
        const skipExisting = options.skipExisting === true;
        const force = options.force === true;

        // Safety: prevent accidental in-place re-embedding
        let sourceReal = sourceDbPath;
        let targetReal = context.store.dbPath;
        try {
          sourceReal = await fs.realpath(sourceDbPath);
        } catch { }
        try {
          targetReal = await fs.realpath(context.store.dbPath);
        } catch { }

        if (!force && sourceReal === targetReal) {
          console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
          process.exit(1);
        }

        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        const table = await db.openTable("memories");

        const scan = await collectLanceRows<Record<string, unknown>>(
          () => table
            .query()
            .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]),
          { maxRows: limit ?? DEFAULT_LANCE_SCAN_MAX_ROWS },
        );
        if (!limit && scan.truncated) {
          throw new Error("CLAWLORE_LANCE_SCAN_LIMIT_EXCEEDED:reembed");
        }
        const sourceRows = scan.rows
          .filter((r: any) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .filter((r: any) => r.id && r.id !== "__schema__");
        const rows = sourceRows.filter((row: any) => isMemoryEntrySafeForEgress({
          text: String(row.text),
          metadata: typeof row.metadata === "string" ? row.metadata : undefined,
        }));
        const safetySkipped = sourceRows.length - rows.length;

        if (rows.length === 0) {
          console.log(safetySkipped > 0
            ? `No safe source memories found; ${safetySkipped} row(s) rejected by egress safety policy.`
            : "No source memories found.");
          return;
        }

        console.log(
          `Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`
        );

        if (dryRun) {
          console.log("DRY RUN - No memories will be written");
          console.log(`First example: ${String(rows[0].id).slice(0, 8)} ${redactMemoryTextForOutput(String(rows[0].text)).slice(0, 80)}`);
          return;
        }

        let processed = safetySkipped;
        let imported = 0;
        let skipped = safetySkipped;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const texts = batch.map((r: any) => String(r.text));
          const vectors = await embedBatchPassage(texts);

          for (let j = 0; j < batch.length; j++) {
            processed++;
            const row = batch[j];
            const vector = vectors[j];

            if (!vector || vector.length === 0) {
              skipped++;
              continue;
            }

            const id = String(row.id);
            if (skipExisting) {
              const exists = await context.store.hasId(id);
              if (exists) {
                skipped++;
                continue;
              }
            }

            const entry: MemoryEntry = {
              id,
              text: String(row.text),
              vector,
              category: (row.category as any) || "other",
              scope: (row.scope as string | undefined) || "global",
              importance: (row.importance != null) ? Number(row.importance) : 0.7,
              timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
              metadata: typeof row.metadata === "string" ? row.metadata : "{}",
            };

            await context.store.importEntry(entry);
            imported++;
          }

          if (processed % 100 === 0 || processed === sourceRows.length) {
            console.log(`Progress: ${processed}/${sourceRows.length} processed, ${imported} imported, ${skipped} skipped`);
          }
        }

        console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
      } catch (error) {
        console.error(`Re-embed failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Upgrade legacy memories to new smart memory format
  memory
    .command("upgrade")
    .description("Upgrade legacy memories to new 6-category L0/L1/L2 smart memory format")
    .option("--dry-run", "Show upgrade statistics without modifying data")
    .option("--batch-size <n>", "Number of memories per batch", "10")
    .option("--use-llm", "Allow sending memory text to the configured LLM for enrichment")
    .option("--rewrite-text", "Rewrite each memory's primary text to its L0 abstract")
    .option("--yes", "Confirm non-dry-run upgrade changes")
    .option("--limit <n>", "Maximum number of memories to upgrade")
    .option("--scope <scope>", "Only upgrade memories in this scope")
    .action(async (options) => {
      try {
        const upgrader = createMemoryUpgrader(
          context.store,
          options.llm === false ? null : (context.llmClient ?? null),
          { log: console.log },
        );

        // Show current status first
        const scopeFilter = options.scope ? [options.scope] : undefined;
        const counts = await upgrader.countLegacy(scopeFilter);

        console.log(`Memory Upgrade Status:`);
        console.log(`• Total memories: ${counts.total}`);
        console.log(`• Legacy (needs upgrade): ${counts.legacy}`);
        console.log(`• Already new format: ${counts.total - counts.legacy}`);
        if (Object.keys(counts.byCategory).length > 0) {
          console.log(`• Legacy by category:`);
          Object.entries(counts.byCategory).forEach(([cat, n]) => {
            console.log(`    ${cat}: ${n}`);
          });
        }

        if (counts.legacy === 0) {
          console.log(`\nAll memories are already in the new format. No upgrade needed.`);
          return;
        }

        if (options.dryRun) {
          console.log(`\n[DRY-RUN] Would upgrade ${counts.legacy} memories.`);
          return;
        }

        if (!options.yes) {
          console.log(`\nRefusing to modify memories without --yes. Re-run with --dry-run first, then add --yes when ready.`);
          return;
        }

        console.log(`\nStarting upgrade...`);
        const result = await upgrader.upgrade({
          dryRun: false,
          batchSize: parseInt(options.batchSize) || 10,
          noLlm: options.useLlm !== true,
          rewriteText: options.rewriteText === true,
          limit: options.limit ? parseInt(options.limit) : undefined,
          scopeFilter,
        });

        console.log(`\nUpgrade Results:`);
        console.log(`• Upgraded: ${result.upgraded}`);
        console.log(`• Already new format: ${result.skipped}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.slice(0, 5).forEach(err => console.log(`  - ${err}`));
          if (result.errors.length > 5) {
            console.log(`  ... and ${result.errors.length - 5} more`);
          }
        }
      } catch (error) {
        console.error(`Upgrade failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // Migration commands
  const migrate = memory
    .command("migrate")
    .description("Migration utilities");

  migrate
    .command("check")
    .description("Check if migration is needed from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const check = await context.migrator.checkMigrationNeeded(options.source);

        console.log("Migration Check Results:");
        console.log(`• Legacy database found: ${check.sourceFound ? 'Yes' : 'No'}`);
        if (check.sourceDbPath) {
          console.log(`• Source path: ${check.sourceDbPath}`);
        }
        if (check.entryCount !== undefined) {
          console.log(`• Entries to migrate: ${check.entryCount}`);
        }
        console.log(`• Migration needed: ${check.needed ? 'Yes' : 'No'}`);
      } catch (error) {
        console.error(`Migration check failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  migrate
    .command("run")
    .description("Run migration from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .option("--principal-key <platform:account:principal>", "Exact canonical private principal")
    .option("--session-key <key>", "Exact OpenClaw private session key")
    .option("--dry-run", "Show what would be migrated without actually migrating")
    .option("--skip-existing", "Skip entries that already exist")
    .action(async (options) => {
      try {
        const target = resolvePrincipalWriteTarget({
          principalKey: options.principalKey,
          sessionKey: options.sessionKey,
        });
        const result = await context.migrator.migrate({
          sourceDbPath: options.source,
          defaultScope: target.scope,
          dryRun: options.dryRun,
          skipExisting: options.skipExisting,
        });

        console.log("Migration Results:");
        console.log(`• Status: ${result.success ? 'Success' : 'Failed'}`);
        console.log(`• Migrated: ${result.migratedCount}`);
        console.log(`• Skipped: ${result.skippedCount}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
        console.log(`• Summary: ${result.summary}`);

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        console.error(`Migration failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  migrate
    .command("verify")
    .description("Verify migration results")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const result = await context.migrator.verifyMigration(options.source);

        console.log("Migration Verification:");
        console.log(`• Valid: ${result.valid ? 'Yes' : 'No'}`);
        console.log(`• Source count: ${result.sourceCount}`);
        console.log(`• Target count: ${result.targetCount}`);

        if (result.issues.length > 0) {
          console.log("• Issues:");
          result.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error(`Verification failed: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });

  // reindex-fts: Rebuild FTS index
  program
    .command("reindex-fts")
    .description("Rebuild the BM25 full-text search index")
    .action(async () => {
      try {
        const status = context.store.getFtsStatus();
        console.log(`FTS status before: available=${status.available}, lastError=${status.lastError || "none"}`);
        const result = await context.store.rebuildFtsIndex();
        if (result.success) {
          console.log("✅ FTS index rebuilt successfully");
        } else {
          console.error(`❌ FTS rebuild failed: ${diagnosticErrorSummary(result.error)}`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`FTS rebuild error: ${diagnosticErrorSummary(error)}`);
        process.exit(1);
      }
    });
}
