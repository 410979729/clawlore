/**
 * CLI Commands for Memory Management
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CLAWLORE_CLI_ALIASES, CLAWLORE_CLI_PRIMARY } from "./src/product-identity.js";
import { createRetriever } from "./src/retriever.js";
import { registerAuthCommands } from "./src/cli/auth-commands.js";
import { clampInt, sleep, tableNames, } from "./src/cli/cli-runtime-policy.js";
import { registerDiagnosticCommands } from "./src/cli/diagnostic-commands.js";
import { registerExperienceCommands } from "./src/cli/experience-commands.js";
import { registerGovernanceCommands } from "./src/cli/governance-commands.js";
import { registerMemoryCommands } from "./src/cli/memory-commands.js";
import { registerMigrationCommands } from "./src/cli/migration-commands.js";
import { registerPrincipalCommands } from "./src/cli/principal-commands.js";
export function registerMemoryCLI(program, context) {
    const getSearchRetriever = () => {
        if (!context.embedder) {
            return context.retriever;
        }
        return createRetriever(context.store, context.embedder, context.retriever.getConfig());
    };
    const runSearch = async (query, limit, scopeFilter, category) => {
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
    const getSqlDbOrThrow = async () => {
        const db = await context.store.getSqlTruthDb();
        if (!db) {
            throw new Error("SQL truth store is not available");
        }
        return db;
    };
    const parseScopeFilter = (value) => {
        const values = Array.isArray(value) ? value : value ? [value] : [];
        const scopes = values
            .flatMap((item) => String(item || "").split(","))
            .map((item) => item.trim())
            .filter(Boolean);
        return scopes.length > 0 ? [...new Set(scopes)] : undefined;
    };
    const parseLimitOption = (value, fallback, max = 5000) => {
        const parsed = Number.parseInt(String(value ?? ""), 10);
        return clampInt(Number.isFinite(parsed) ? parsed : fallback, 1, max);
    };
    const dryRunFromApplyOptions = (options) => options.dryRun === true || options.apply !== true;
    const loadKnowledgeDocs = async (rootDir, limit = 80) => {
        const root = typeof rootDir === "string" && rootDir.trim() ? path.resolve(rootDir.trim()) : "";
        if (!root)
            return [];
        const docs = [];
        const visit = async (dir, depth) => {
            if (docs.length >= limit || depth > 4)
                return;
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (docs.length >= limit)
                    return;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === "node_modules" || entry.name.startsWith("."))
                        continue;
                    await visit(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith(".md"))
                    continue;
                try {
                    const info = await stat(fullPath);
                    if (info.size > 256_000)
                        continue;
                    const text = await readFile(fullPath, "utf8");
                    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
                    docs.push({ path: fullPath, title, text: text.slice(0, 12_000) });
                }
                catch {
                    // Ignore unreadable docs; bridge dedupe is advisory.
                }
            }
        };
        await visit(root, 0);
        return docs;
    };
    const hasTables = (db, names) => {
        const existing = tableNames(db);
        return names.every((name) => existing.has(name));
    };
    const requireExperienceTables = (db) => hasTables(db, [
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
        const commandWithHook = memory;
        commandWithHook.hook("preAction", async (_thisCommand, actionCommand) => {
            const path = [];
            let current = actionCommand;
            while (current && current !== memory) {
                path.unshift(current.name());
                current = current.parent;
            }
            await context.beforeAction?.(path);
        });
    }
    const runtime = {
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
    registerPrincipalCommands(runtime);
    registerMemoryCommands(runtime);
    registerDiagnosticCommands(runtime);
    registerGovernanceCommands(runtime);
    registerExperienceCommands(runtime);
    registerMigrationCommands(runtime);
}
// ============================================================================
// Factory Function
// ============================================================================
export function createMemoryCLI(context) {
    return ({ program }) => registerMemoryCLI(program, context);
}
