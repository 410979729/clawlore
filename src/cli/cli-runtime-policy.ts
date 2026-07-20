/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import {
  redactDigestReportForDiagnostics,
  redactDigestRunForDiagnostics,
} from "../diagnostics-redaction.js";
import {
  digestReport
} from "../digest-pipeline.js";
import {
  type ExistingKnowledgeDoc
} from "../knowledge-skill-bridge.js";
import type { LlmClient } from "../llm-client.js";
import { redactMemoryTextForOutput } from "../memory-egress-policy.js";
import {
  getDefaultOauthModelForProvider,
  isOauthModelSupported,
  listOAuthProviders,
  normalizeOAuthProviderId
} from "../llm-oauth.js";
import type { MemoryMigrator } from "../migrate.js";
import { type MemoryRetriever } from "../retriever.js";
import { type MemoryStore } from "../store.js";

export * from "./auth-config-transaction.js";

export type DatabaseSync = any;

export interface CliScopeManagerPort {
  getStats(): { totalScopes: number;[key: string]: unknown };
  getDefaultScope(agentId?: string): string;
}

// ============================================================================
// Types
// ============================================================================

export interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: CliScopeManagerPort;
  migrator: MemoryMigrator;
  embedder?: import("../embedder.js").TextEmbedder;
  llmClient?: LlmClient;
  pluginId?: string;
  pluginConfig?: Record<string, unknown>;
  runtimeDiagnosticFile?: string;
  oauthTestHooks?: {
    openUrl?: (url: string) => void | Promise<void>;
    authorizeUrl?: (url: string) => void | Promise<void>;
    chooseProvider?: (
      providers: Array<{ id: string; label: string; defaultModel: string }>,
      currentProviderId: string,
    ) => string | Promise<string>;
  };
  beforeAction?: (commandPath: string[]) => void | Promise<void>;
}

export type ChooseOAuthProviderHook = NonNullable<
  NonNullable<CLIContext["oauthTestHooks"]>["chooseProvider"]
>;

// ============================================================================
// Utility Functions
// ============================================================================

export function getPluginVersion(): string {
  // This module is two levels below the package root in source and three
  // levels below it after compilation into dist/src/cli.
  for (const relativePath of ["../../package.json", "../../../package.json"]) {
    try {
      const pkgUrl = new URL(relativePath, import.meta.url);
      const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Try the other stable source/compiled layout before failing closed.
    }
  }
  return "unknown";
}

export function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export const OAUTH_PROVIDER_CHOICES = listOAuthProviders()
  .map((provider) => `${provider.id} (${provider.label})`)
  .join(", ");

export function pickOauthProvider(currentProvider: string | undefined, overrideProvider: string | undefined): {
  providerId: string;
  source: "override" | "config" | "default";
} {
  if (overrideProvider && overrideProvider.trim()) {
    return { providerId: normalizeOAuthProviderId(overrideProvider), source: "override" };
  }

  if (currentProvider && currentProvider.trim()) {
    try {
      return { providerId: normalizeOAuthProviderId(currentProvider), source: "config" };
    } catch {
      // Fall back to the default provider when the saved config is stale or invalid.
    }
  }

  return { providerId: normalizeOAuthProviderId(), source: "default" };
}

export async function promptOauthProviderSelection(
  currentProviderId: string,
  testHook?: ChooseOAuthProviderHook,
): Promise<{ providerId: string; source: "prompt" | "default" }> {
  const providers = listOAuthProviders();
  if (providers.length === 0) {
    throw new Error("No OAuth providers are available.");
  }

  if (testHook) {
    const selected = await testHook(providers, currentProviderId);
    return { providerId: normalizeOAuthProviderId(selected), source: "prompt" };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { providerId: currentProviderId, source: "default" };
  }

  let selectedIndex = providers.findIndex((provider) => provider.id === currentProviderId);
  if (selectedIndex < 0) selectedIndex = 0;

  readline.emitKeypressEvents(process.stdin);
  const canSetRawMode = typeof process.stdin.setRawMode === "function";
  const previousRawMode = canSetRawMode ? !!process.stdin.isRaw : false;
  const menuLines = 2 + providers.length;
  let hasRendered = false;

  const render = () => {
    if (hasRendered) {
      readline.moveCursor(process.stdout, 0, -menuLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    } else {
      process.stdout.write("\n");
      hasRendered = true;
    }

    process.stdout.write("Select OAuth provider\n");
    process.stdout.write("Use arrow keys and Enter.\n");
    providers.forEach((provider, index) => {
      const marker = index === selectedIndex ? ">" : " ";
      process.stdout.write(
        `${marker} ${provider.label} (${provider.id}) [default model: ${provider.defaultModel}]\n`,
      );
    });
  };

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      if (canSetRawMode) {
        process.stdin.setRawMode(previousRawMode);
      }
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "escape") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + providers.length) % providers.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "right") {
        selectedIndex = (selectedIndex + 1) % providers.length;
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const provider = providers[selectedIndex];
        cleanup();
        resolve({ providerId: provider.id, source: "prompt" });
      }
    };

    render();
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    if (canSetRawMode) {
      process.stdin.setRawMode(true);
    }
  });
}

export async function resolveOauthProviderSelection(
  currentProvider: string | undefined,
  overrideProvider: string | undefined,
  chooseProviderHook?: ChooseOAuthProviderHook,
): Promise<{ providerId: string; source: "override" | "config" | "default" | "prompt" }> {
  if (overrideProvider && overrideProvider.trim()) {
    return pickOauthProvider(currentProvider, overrideProvider);
  }

  const initial = pickOauthProvider(currentProvider, undefined);
  return await promptOauthProviderSelection(initial.providerId, chooseProviderHook);
}

export function pickOauthModel(
  providerId: string,
  currentModel: string | undefined,
  overrideModel: string | undefined,
): { model: string; source: "override" | "config" | "default" } {
  if (overrideModel && overrideModel.trim()) {
    if (!isOauthModelSupported(providerId, overrideModel)) {
      throw new Error(
        `Model "${overrideModel}" is not supported for OAuth provider ${providerId}. Use a compatible model such as ${getDefaultOauthModelForProvider(providerId)}.`,
      );
    }
    return { model: overrideModel.trim(), source: "override" };
  }

  if (isOauthModelSupported(providerId, currentModel)) {
    return { model: currentModel!.trim(), source: "config" };
  }

  return { model: getDefaultOauthModelForProvider(providerId), source: "default" };
}

export function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = redactMemoryTextForOutput(String(memory.text || ""));
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  return `${prefix}[${id}] [${redactMemoryTextForOutput(String(memory.category || ""))}:${redactMemoryTextForOutput(String(memory.scope || ""))}] ${text} (${date})`;
}

export function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

export function writeJson(obj: any): void {
  process.stdout.write(`${formatJson(obj)}\n`);
}

export function stableRecordEntries(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

export function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

export function groupedCounts(db: DatabaseSync, sql: string): Record<string, number> {
  const rows = db.prepare(sql).all() as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [String(row.key || ""), Number(row.count || 0)]));
}

export function collectExperienceHealth(db: DatabaseSync | null): Record<string, unknown> {
  const required = [
    "task_episodes",
    "procedural_playbooks",
    "procedural_playbooks_fts",
    "playbook_versions",
    "experience_runs",
    "task_experience_capture_events",
  ];
  if (!db) {
    return { enabled: true, status: "unavailable", missingTables: required };
  }
  const tables = tableNames(db);
  const missing = required.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    return { enabled: true, status: "schema_missing", missingTables: missing };
  }
  const playbookTotal = Number(db.prepare("SELECT COUNT(*) AS count FROM procedural_playbooks").get()?.count || 0);
  const episodeTotal = Number(db.prepare("SELECT COUNT(*) AS count FROM task_episodes").get()?.count || 0);
  const runTotal = Number(db.prepare("SELECT COUNT(*) AS count FROM experience_runs").get()?.count || 0);
  const captureEventTotal = Number(db.prepare("SELECT COUNT(*) AS count FROM task_experience_capture_events").get()?.count || 0);
  return {
    enabled: true,
    status: "ready",
    tables: required,
    episodes: {
      total: episodeTotal,
      byStatus: groupedCounts(db, "SELECT status AS key, COUNT(*) AS count FROM task_episodes GROUP BY status"),
    },
    playbooks: {
      total: playbookTotal,
      byStatus: groupedCounts(db, "SELECT status AS key, COUNT(*) AS count FROM procedural_playbooks GROUP BY status"),
    },
    runs: {
      total: runTotal,
      byOutcome: groupedCounts(db, "SELECT outcome AS key, COUNT(*) AS count FROM experience_runs GROUP BY outcome"),
    },
    captureEvents: {
      total: captureEventTotal,
      byAction: groupedCounts(db, "SELECT action AS key, COUNT(*) AS count FROM task_experience_capture_events GROUP BY action"),
      skippedByReason: groupedCounts(db, "SELECT reason AS key, COUNT(*) AS count FROM task_experience_capture_events WHERE action = 'skipped' GROUP BY reason"),
    },
  };
}

export function collectNightlyDigestHealth(db: DatabaseSync | null): Record<string, unknown> {
  if (!db) {
    return { enabled: false, status: "unavailable" };
  }
  const nativeDigest = redactDigestReportForDiagnostics(digestReport(db, { sampleLimit: 0 }));
  const tables = tableNames(db);
  if (!tables.has("nightly_digest_runs")) {
    return {
      enabled: true,
      status: nativeDigest.status === "not_initialized" ? "not_initialized" : nativeDigest.status,
      legacy: {
        enabled: false,
        status: "not_initialized",
        message: "No nightly digest run ledger is present in this OpenClaw deployment.",
      },
      native: nativeDigest,
    };
  }
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM nightly_digest_runs").get()?.count || 0);
  const lastRun = db.prepare(
    "SELECT * FROM nightly_digest_runs ORDER BY started_at DESC LIMIT 1",
  ).get() as Record<string, unknown> | undefined;
  return {
    enabled: true,
    status: "ready",
    runs: {
      total,
      byStatus: groupedCounts(db, "SELECT status AS key, COUNT(*) AS count FROM nightly_digest_runs GROUP BY status"),
    },
    lastRun: redactDigestRunForDiagnostics(lastRun),
    native: nativeDigest,
  };
}

export function recordsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  return JSON.stringify(stableRecordEntries(a)) === JSON.stringify(stableRecordEntries(b));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// CLI Command Implementations
// ============================================================================


export interface CliRegistrationContext {
  program: Command;
  memory: Command;
  context: CLIContext;
  runSearch(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Awaited<ReturnType<MemoryRetriever["retrieve"]>>>;
  getSqlDbOrThrow(): Promise<DatabaseSync>;
  parseScopeFilter(value: unknown): string[] | undefined;
  parseLimitOption(value: unknown, fallback: number, max?: number): number;
  dryRunFromApplyOptions(options: { dryRun?: boolean; apply?: boolean }): boolean;
  loadKnowledgeDocs(rootDir: unknown, limit?: number): Promise<ExistingKnowledgeDoc[]>;
  hasTables(db: DatabaseSync, names: string[]): boolean;
  requireExperienceTables(db: DatabaseSync): boolean;
}
