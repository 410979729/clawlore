/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type ExistingKnowledgeDoc
} from "./src/knowledge-skill-bridge.js";
import {
  CLAWLORE_CLI_ALIASES,
  CLAWLORE_CLI_PRIMARY
} from "./src/product-identity.js";
import { createRetriever, type MemoryRetriever } from "./src/retriever.js";

import { registerAuthCommands } from "./src/cli/auth-commands.js";
import {
  clampInt,
  sleep,
  tableNames,
  type CLIContext,
  type CliRegistrationContext,
  type DatabaseSync,
} from "./src/cli/cli-runtime-policy.js";
import { registerDiagnosticCommands } from "./src/cli/diagnostic-commands.js";
import { registerExperienceCommands } from "./src/cli/experience-commands.js";
import { registerGovernanceCommands } from "./src/cli/governance-commands.js";
import { registerMemoryCommands } from "./src/cli/memory-commands.js";
import { registerMigrationCommands } from "./src/cli/migration-commands.js";

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  const getSearchRetriever = (): MemoryRetriever => {
    if (!context.embedder) {
      return context.retriever;
    }
    return createRetriever(context.store, context.embedder, context.retriever.getConfig());
  };

  const runSearch = async (
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ) => {
    let results = await getSearchRetriever().retrieve({
      query,
      limit,
      scopeFilter,
      category,
      source: "cli",
    });

    if (results.length === 0 && context.embedder) {
      await sleep(75);
      results = await getSearchRetriever().retrieve({
        query,
        limit,
        scopeFilter,
        category,
        source: "cli",
      });
    }

    return results;
  };

  const getSqlDbOrThrow = async (): Promise<DatabaseSync> => {
    const db = await context.store.getSqlTruthDb();
    if (!db) {
      throw new Error("SQL truth store is not available");
    }
    return db;
  };

  const parseScopeFilter = (value: unknown): string[] | undefined => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const scopes = values
      .flatMap((item) => String(item || "").split(","))
      .map((item) => item.trim())
      .filter(Boolean);
    return scopes.length > 0 ? [...new Set(scopes)] : undefined;
  };

  const parseLimitOption = (value: unknown, fallback: number, max = 5000): number => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return clampInt(Number.isFinite(parsed) ? parsed : fallback, 1, max);
  };

  const dryRunFromApplyOptions = (options: { dryRun?: boolean; apply?: boolean }): boolean =>
    options.dryRun === true || options.apply !== true;

  const loadKnowledgeDocs = async (rootDir: unknown, limit = 80): Promise<ExistingKnowledgeDoc[]> => {
    const root = typeof rootDir === "string" && rootDir.trim() ? path.resolve(rootDir.trim()) : "";
    if (!root) return [];
    const docs: ExistingKnowledgeDoc[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (docs.length >= limit || depth > 4) return;
      let entries: any[];
      try {
        entries = await readdir(dir, { withFileTypes: true }) as any[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (docs.length >= limit) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          await visit(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        try {
          const info = await stat(fullPath);
          if (info.size > 256_000) continue;
          const text = await readFile(fullPath, "utf8");
          const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
          docs.push({ path: fullPath, title, text: text.slice(0, 12_000) });
        } catch {
          // Ignore unreadable docs; bridge dedupe is advisory.
        }
      }
    };
    await visit(root, 0);
    return docs;
  };

  const hasTables = (db: DatabaseSync, names: string[]): boolean => {
    const existing = tableNames(db);
    return names.every((name) => existing.has(name));
  };

  const requireExperienceTables = (db: DatabaseSync): boolean => hasTables(db, [
    "task_episodes",
    "procedural_playbooks",
    "procedural_playbooks_fts",
    "playbook_versions",
    "experience_runs",
    "task_experience_capture_events",
  ]);

  const memory = program
    .command(CLAWLORE_CLI_PRIMARY)
    .alias(CLAWLORE_CLI_ALIASES[0])
    .alias(CLAWLORE_CLI_ALIASES[1])
    .description("ClawLore memory management commands");

  if (context.beforeAction) {
    const commandWithHook = memory as Command & {
      hook(
        event: "preAction",
        listener: (thisCommand: Command, actionCommand: Command) => void | Promise<void>,
      ): Command;
    };
    commandWithHook.hook("preAction", async (_thisCommand, actionCommand) => {
      const path: string[] = [];
      let current: (Command & { parent?: Command; name(): string }) | undefined = actionCommand as Command & {
        parent?: Command;
        name(): string;
      };
      while (current && current !== memory) {
        path.unshift(current.name());
        current = current.parent as typeof current;
      }
      await context.beforeAction?.(path);
    });
  }


  const runtime: CliRegistrationContext = {
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
  };
  registerAuthCommands(runtime);
  registerMemoryCommands(runtime);
  registerDiagnosticCommands(runtime);
  registerGovernanceCommands(runtime);
  registerExperienceCommands(runtime);
  registerMigrationCommands(runtime);
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => registerMemoryCLI(program, context);
}
