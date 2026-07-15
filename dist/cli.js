/**
 * CLI Commands for Memory Management
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import JSON5 from "json5";
import { CLAWLORE_CLI_ALIASES, CLAWLORE_CLI_PRIMARY, CLAWLORE_LEGACY_DEFAULTS, CLAWLORE_PLUGIN_ID, } from "./src/product-identity.js";
import { loadLanceDB } from "./src/store.js";
import { createRetriever } from "./src/retriever.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";
import { buildOperatorDashboard } from "./src/operator-dashboard.js";
import { candidateDebtReport, promoteMemoryCandidates } from "./src/candidate-promotion.js";
import { digestRecoveryReport, digestReport, recoverDigestChunks, runDigestPipeline, } from "./src/digest-pipeline.js";
import { redactDigestReportForDiagnostics, redactDigestRunForDiagnostics, } from "./src/diagnostics-redaction.js";
import { applyCleanup, rollbackCleanupBatch } from "./src/governance-cleanup.js";
import { graphHygieneReport, repairGraphHygiene } from "./src/graph-hygiene.js";
import { recoveryReport, scheduleReplay } from "./src/journal-recovery.js";
import { buildForgettingReport, runForgettingWithVectorSync } from "./src/forgetting.js";
import { buildExperienceDebtReport } from "./src/experience-governance.js";
import { promoteExperiences } from "./src/experience-promotion.js";
import { runPromotionBatch } from "./src/experience-promotion-batch.js";
import { listAutoRecallTraces } from "./src/auto-recall-ledger.js";
import { evaluateRecallScopePolicy, scopeIdForContext } from "./src/scope-policy.js";
import { diagnosticErrorSummary } from "./src/diagnostic-redaction.js";
import { buildKnowledgeSkillDrafts, } from "./src/knowledge-skill-bridge.js";
import { ensureExperienceSchema, getExperienceStats, reviewPlaybook, searchPlaybooks, } from "./src/experience-store.js";
import { loadReplayCases, runReplaySuite } from "./src/experience-replay.js";
import { getDefaultOauthModelForProvider, getOAuthProviderLabel, isOauthModelSupported, listOAuthProviders, normalizeOauthModel, normalizeOAuthProviderId, performOAuthLogin, } from "./src/llm-oauth.js";
// ============================================================================
// Utility Functions
// ============================================================================
function getPluginVersion() {
    for (const relativePath of ["./package.json", "../package.json"]) {
        try {
            const pkgUrl = new URL(relativePath, import.meta.url);
            const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
            if (pkg.version)
                return pkg.version;
        }
        catch {
            // Source execution uses ./package.json; compiled dist execution uses ../package.json.
        }
    }
    return "unknown";
}
function clampInt(value, min, max) {
    const n = Number.isFinite(value) ? value : min;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}
function resolveOpenClawConfigPath(explicit) {
    const openclawHome = resolveOpenClawHome();
    if (explicit && explicit.trim()) {
        return path.resolve(explicit.trim());
    }
    const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
    if (fromEnv) {
        return path.resolve(fromEnv);
    }
    return path.join(openclawHome, "openclaw.json");
}
function resolveOpenClawHome() {
    return process.env.OPENCLAW_HOME?.trim()
        ? path.resolve(process.env.OPENCLAW_HOME.trim())
        : path.join(homedir(), ".openclaw");
}
function resolveDefaultOauthPath() {
    const home = resolveOpenClawHome();
    const canonical = path.join(home, ".clawlore", "oauth.json");
    const legacy = path.join(home, CLAWLORE_LEGACY_DEFAULTS.oauthDirectoryName, "oauth.json");
    return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
}
function resolveLoginOauthPath(rawPath) {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    const candidate = trimmed || resolveDefaultOauthPath();
    return path.resolve(candidate);
}
function resolveConfiguredOauthPath(configPath, rawPath) {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!trimmed) {
        return resolveDefaultOauthPath();
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    return path.resolve(path.dirname(configPath), trimmed);
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOauthLlmConfig(value) {
    return isPlainObject(value) && value.auth === "oauth";
}
function extractRestorableApiKeyLlmConfig(value) {
    if (!isPlainObject(value)) {
        return {};
    }
    const result = {};
    if (value.auth === "api-key") {
        result.auth = "api-key";
    }
    if (typeof value.model === "string") {
        result.model = value.model;
    }
    if (typeof value.baseURL === "string") {
        result.baseURL = value.baseURL;
    }
    if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
        result.timeoutMs = Math.trunc(value.timeoutMs);
    }
    return result;
}
function extractOauthSafeLlmConfig(value) {
    if (!isPlainObject(value)) {
        return {};
    }
    const result = {};
    if (typeof value.baseURL === "string") {
        result.baseURL = value.baseURL;
    }
    if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
        result.timeoutMs = Math.trunc(value.timeoutMs);
    }
    return result;
}
function hasRestorableApiKeyLlmConfig(value) {
    return Object.keys(value).length > 0;
}
function buildLogoutFallbackLlmConfig(value) {
    if (isOauthLlmConfig(value)) {
        return extractOauthSafeLlmConfig(value);
    }
    return extractRestorableApiKeyLlmConfig(value);
}
function getOauthBackupPath(oauthPath) {
    const parsed = path.parse(oauthPath);
    const fileName = parsed.ext
        ? `${parsed.name}.llm-backup${parsed.ext}`
        : `${parsed.base}.llm-backup.json`;
    return path.join(parsed.dir, fileName);
}
async function saveOauthLlmBackup(oauthPath, llm, hadLlmConfig) {
    const backupPath = getOauthBackupPath(oauthPath);
    const payload = {
        version: 1,
        hadLlmConfig,
        llm: extractRestorableApiKeyLlmConfig(llm),
    };
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
async function loadOauthLlmBackup(oauthPath) {
    const backupPath = getOauthBackupPath(oauthPath);
    try {
        const raw = await readFile(backupPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.hadLlmConfig !== "boolean") {
            return null;
        }
        return {
            version: 1,
            hadLlmConfig: parsed.hadLlmConfig,
            llm: extractRestorableApiKeyLlmConfig(parsed.llm),
        };
    }
    catch {
        return null;
    }
}
const OAUTH_PROVIDER_CHOICES = listOAuthProviders()
    .map((provider) => `${provider.id} (${provider.label})`)
    .join(", ");
function pickOauthProvider(currentProvider, overrideProvider) {
    if (overrideProvider && overrideProvider.trim()) {
        return { providerId: normalizeOAuthProviderId(overrideProvider), source: "override" };
    }
    if (currentProvider && currentProvider.trim()) {
        try {
            return { providerId: normalizeOAuthProviderId(currentProvider), source: "config" };
        }
        catch {
            // Fall back to the default provider when the saved config is stale or invalid.
        }
    }
    return { providerId: normalizeOAuthProviderId(), source: "default" };
}
async function promptOauthProviderSelection(currentProviderId, testHook) {
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
    if (selectedIndex < 0)
        selectedIndex = 0;
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
        }
        else {
            process.stdout.write("\n");
            hasRendered = true;
        }
        process.stdout.write("Select OAuth provider\n");
        process.stdout.write("Use arrow keys and Enter.\n");
        providers.forEach((provider, index) => {
            const marker = index === selectedIndex ? ">" : " ";
            process.stdout.write(`${marker} ${provider.label} (${provider.id}) [default model: ${provider.defaultModel}]\n`);
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
        const onKeypress = (_str, key) => {
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
async function resolveOauthProviderSelection(currentProvider, overrideProvider, chooseProviderHook) {
    if (overrideProvider && overrideProvider.trim()) {
        return pickOauthProvider(currentProvider, overrideProvider);
    }
    const initial = pickOauthProvider(currentProvider, undefined);
    return await promptOauthProviderSelection(initial.providerId, chooseProviderHook);
}
function pickOauthModel(providerId, currentModel, overrideModel) {
    if (overrideModel && overrideModel.trim()) {
        if (!isOauthModelSupported(providerId, overrideModel)) {
            throw new Error(`Model "${overrideModel}" is not supported for OAuth provider ${providerId}. Use a compatible model such as ${getDefaultOauthModelForProvider(providerId)}.`);
        }
        return { model: overrideModel.trim(), source: "override" };
    }
    if (isOauthModelSupported(providerId, currentModel)) {
        return { model: currentModel.trim(), source: "config" };
    }
    return { model: getDefaultOauthModelForProvider(providerId), source: "default" };
}
async function loadOpenClawConfig(configPath) {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid OpenClaw config at ${configPath}: expected object`);
    }
    return parsed;
}
function ensurePluginConfigRoot(config, pluginId) {
    config.plugins ||= {};
    config.plugins.entries ||= {};
    config.plugins.entries[pluginId] ||= { enabled: true, config: {} };
    const entry = config.plugins.entries[pluginId];
    entry.enabled = true;
    entry.config ||= {};
    return entry.config;
}
function getExistingPluginConfigRoot(config, pluginId) {
    const plugins = isPlainObject(config.plugins) ? config.plugins : {};
    const entries = isPlainObject(plugins.entries) ? plugins.entries : {};
    const entry = isPlainObject(entries[pluginId]) ? entries[pluginId] : {};
    return isPlainObject(entry.config) ? entry.config : {};
}
async function saveOpenClawConfig(configPath, config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
function formatMemory(memory, index) {
    const prefix = index !== undefined ? `${index + 1}. ` : "";
    const id = memory?.id ? String(memory.id) : "unknown";
    const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
    const fullText = String(memory.text || "");
    const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
    return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}
function formatJson(obj) {
    return JSON.stringify(obj, null, 2);
}
function writeJson(obj) {
    process.stdout.write(`${formatJson(obj)}\n`);
}
function stableRecordEntries(record) {
    return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}
function tableNames(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all();
    return new Set(rows.map((row) => String(row.name)));
}
function groupedCounts(db, sql) {
    const rows = db.prepare(sql).all();
    return Object.fromEntries(rows.map((row) => [String(row.key || ""), Number(row.count || 0)]));
}
function collectExperienceHealth(db) {
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
function collectNightlyDigestHealth(db) {
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
    const lastRun = db.prepare("SELECT * FROM nightly_digest_runs ORDER BY started_at DESC LIMIT 1").get();
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
function recordsEqual(a, b) {
    return JSON.stringify(stableRecordEntries(a)) === JSON.stringify(stableRecordEntries(b));
}
async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}
// ============================================================================
// CLI Command Implementations
// ============================================================================
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
    // Version
    memory
        .command("version")
        .description("Print plugin version")
        .action(() => {
        console.log(getPluginVersion());
    });
    const auth = memory
        .command("auth")
        .description("Manage OAuth authentication for smart-extraction LLM access");
    auth
        .command("login")
        .description("Authenticate with ChatGPT/Codex from a printed authorization URL, save the plugin OAuth file, and switch this plugin to llm.auth=oauth")
        .option("--config <path>", "OpenClaw config file to update")
        .option("--provider <provider>", `OAuth provider to use (${OAUTH_PROVIDER_CHOICES})`)
        .option("--model <model>", "Override the model saved into llm.model")
        .option("--oauth-path <path>", "OAuth file path (default: ~/.openclaw/.clawlore/oauth.json; an existing legacy path is reused)")
        .option("--timeout <seconds>", "OAuth callback timeout in seconds", "120")
        .option("--no-browser", "Compatibility flag; the command prints the authorization URL and does not launch a browser")
        .action(async (options) => {
        try {
            const pluginId = context.pluginId || CLAWLORE_PLUGIN_ID;
            const currentLlm = context.pluginConfig?.llm;
            const currentProvider = currentLlm && typeof currentLlm === "object" && typeof currentLlm.oauthProvider === "string"
                ? String(currentLlm.oauthProvider)
                : undefined;
            const selectedProvider = await resolveOauthProviderSelection(currentProvider, options.provider, context.oauthTestHooks?.chooseProvider);
            const currentModel = currentLlm && typeof currentLlm === "object" && typeof currentLlm.model === "string"
                ? String(currentLlm.model)
                : undefined;
            const selectedModel = pickOauthModel(selectedProvider.providerId, currentModel, options.model);
            const oauthModel = normalizeOauthModel(selectedModel.model);
            const configPath = resolveOpenClawConfigPath(options.config);
            const oauthPath = resolveLoginOauthPath(options.oauthPath);
            const timeoutMs = clampInt((parseInt(options.timeout, 10) || 120) * 1000, 15_000, 900_000);
            if (selectedModel.source === "default" && currentModel && currentModel.trim()) {
                console.log(`Configured llm.model "${currentModel}" is not supported by provider ${selectedProvider.providerId}. Falling back to ${getDefaultOauthModelForProvider(selectedProvider.providerId)}.`);
            }
            console.log(`Config file: ${configPath}`);
            console.log(`Provider: ${getOAuthProviderLabel(selectedProvider.providerId)} (${selectedProvider.providerId}, ${selectedProvider.source})`);
            console.log(`OAuth file: ${oauthPath}`);
            console.log(`Model: ${oauthModel} (${selectedModel.source})`);
            const { session } = await performOAuthLogin({
                authPath: oauthPath,
                timeoutMs,
                noBrowser: options.browser === false,
                model: selectedModel.model,
                providerId: selectedProvider.providerId,
                onOpenUrl: context.oauthTestHooks?.openUrl,
                onAuthorizeUrl: async (url) => {
                    console.log(`Authorization URL: ${url}`);
                    await context.oauthTestHooks?.authorizeUrl?.(url);
                },
            });
            const openclawConfig = await loadOpenClawConfig(configPath);
            const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
            const hadLlmConfig = isPlainObject(pluginConfig.llm);
            const existingLlm = hadLlmConfig ? { ...pluginConfig.llm } : {};
            const wasOauthMode = isOauthLlmConfig(existingLlm);
            if (!wasOauthMode) {
                await saveOauthLlmBackup(oauthPath, pluginConfig.llm, hadLlmConfig);
            }
            const nextLlm = wasOauthMode ? { ...existingLlm } : extractOauthSafeLlmConfig(existingLlm);
            if (!wasOauthMode) {
                delete nextLlm.baseURL;
            }
            pluginConfig.llm = {
                ...nextLlm,
                auth: "oauth",
                oauthProvider: selectedProvider.providerId,
                model: oauthModel,
                oauthPath,
            };
            await saveOpenClawConfig(configPath, openclawConfig);
            console.log(`OAuth login completed for account ${session.accountId}.`);
            console.log(`Updated ${pluginId} config: llm.auth=oauth, llm.oauthProvider=${selectedProvider.providerId}, llm.oauthPath=${oauthPath}, llm.model=${oauthModel}`);
        }
        catch (error) {
            console.error("OAuth login failed:", error);
            process.exit(1);
        }
    });
    auth
        .command("status")
        .description("Show the current OAuth configuration for this plugin")
        .option("--config <path>", "OpenClaw config file to inspect")
        .action(async (options) => {
        try {
            const pluginId = context.pluginId || CLAWLORE_PLUGIN_ID;
            const configPath = resolveOpenClawConfigPath(options.config);
            const openclawConfig = await loadOpenClawConfig(configPath);
            const pluginConfig = getExistingPluginConfigRoot(openclawConfig, pluginId);
            const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm : {};
            const oauthProviderRaw = typeof llm.oauthProvider === "string" && llm.oauthProvider.trim()
                ? llm.oauthProvider.trim()
                : normalizeOAuthProviderId();
            let oauthProviderDisplay = `${oauthProviderRaw} (unknown)`;
            try {
                oauthProviderDisplay = `${normalizeOAuthProviderId(oauthProviderRaw)} (${getOAuthProviderLabel(oauthProviderRaw)})`;
            }
            catch {
                // Leave the raw provider id visible for debugging stale or unsupported configs.
            }
            const oauthPath = resolveConfiguredOauthPath(configPath, llm.oauthPath);
            let tokenInfo = "missing";
            try {
                const session = await readFile(oauthPath, "utf8");
                tokenInfo = session.trim() ? "present" : "empty";
            }
            catch {
                tokenInfo = "missing";
            }
            console.log(`Config file: ${configPath}`);
            console.log(`Plugin: ${pluginId}`);
            console.log(`llm.auth: ${typeof llm.auth === "string" ? llm.auth : "api-key"}`);
            console.log(`llm.oauthProvider: ${oauthProviderDisplay}`);
            console.log(`llm.model: ${typeof llm.model === "string" ? llm.model : "openai/gpt-oss-120b"}`);
            console.log(`llm.oauthPath: ${oauthPath}`);
            console.log(`oauth file: ${tokenInfo}`);
        }
        catch (error) {
            console.error("OAuth status failed:", error);
            process.exit(1);
        }
    });
    auth
        .command("logout")
        .description("Delete the plugin OAuth file and switch this plugin back to llm.auth=api-key")
        .option("--config <path>", "OpenClaw config file to update")
        .option("--oauth-path <path>", "OAuth file path to remove")
        .action(async (options) => {
        try {
            const pluginId = context.pluginId || CLAWLORE_PLUGIN_ID;
            const configPath = resolveOpenClawConfigPath(options.config);
            const openclawConfig = await loadOpenClawConfig(configPath);
            const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
            const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm : {};
            const oauthPath = options.oauthPath && String(options.oauthPath).trim()
                ? resolveLoginOauthPath(options.oauthPath)
                : resolveConfiguredOauthPath(configPath, llm.oauthPath);
            const backupPath = getOauthBackupPath(oauthPath);
            const backup = await loadOauthLlmBackup(oauthPath);
            await rm(oauthPath, { force: true });
            await rm(backupPath, { force: true });
            if (backup) {
                if (backup.hadLlmConfig) {
                    pluginConfig.llm = { ...backup.llm };
                }
                else {
                    delete pluginConfig.llm;
                }
            }
            else {
                const fallbackLlm = buildLogoutFallbackLlmConfig(llm);
                if (hasRestorableApiKeyLlmConfig(fallbackLlm)) {
                    pluginConfig.llm = fallbackLlm;
                }
                else {
                    delete pluginConfig.llm;
                }
            }
            await saveOpenClawConfig(configPath, openclawConfig);
            console.log(`Deleted OAuth file: ${oauthPath}`);
            console.log(`Updated ${pluginId} config: llm.auth=api-key`);
        }
        catch (error) {
            console.error("OAuth logout failed:", error);
            process.exit(1);
        }
    });
    // List memories
    memory
        .command("list")
        .description("List memories with optional filtering")
        .option("--scope <scope>", "Filter by scope")
        .option("--category <category>", "Filter by category")
        .option("--limit <n>", "Maximum number of results", "20")
        .option("--offset <n>", "Number of results to skip", "0")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const limit = parseInt(options.limit) || 20;
            const offset = parseInt(options.offset) || 0;
            let scopeFilter;
            if (options.scope) {
                scopeFilter = [options.scope];
            }
            const memories = await context.store.list(scopeFilter, options.category, limit, offset);
            if (options.json) {
                console.log(formatJson(memories));
            }
            else {
                if (memories.length === 0) {
                    console.log("No memories found.");
                }
                else {
                    console.log(`Found ${memories.length} memories:\n`);
                    memories.forEach((memory, i) => {
                        console.log(formatMemory(memory, offset + i));
                    });
                }
            }
        }
        catch (error) {
            console.error("Failed to list memories:", error);
            process.exit(1);
        }
    });
    // Search memories
    memory
        .command("search <query>")
        .description("Search memories using hybrid retrieval")
        .option("--scope <scope>", "Search within specific scope")
        .option("--category <category>", "Filter by category")
        .option("--limit <n>", "Maximum number of results", "10")
        .option("--json", "Output as JSON")
        .action(async (query, options) => {
        try {
            const limit = parseInt(options.limit) || 10;
            let scopeFilter;
            if (options.scope) {
                scopeFilter = [options.scope];
            }
            const results = await runSearch(query, limit, scopeFilter, options.category);
            if (options.json) {
                console.log(formatJson(results));
            }
            else {
                if (results.length === 0) {
                    console.log("No relevant memories found.");
                }
                else {
                    console.log(`Found ${results.length} memories:\n`);
                    results.forEach((result, i) => {
                        const sources = [];
                        if (result.sources.vector)
                            sources.push("vector");
                        if (result.sources.bm25)
                            sources.push("BM25");
                        if (result.sources.reranked)
                            sources.push("reranked");
                        console.log(`${i + 1}. [${result.entry.id}] [${result.entry.category}:${result.entry.scope}] ${result.entry.text} ` +
                            `(${(result.score * 100).toFixed(0)}%, ${sources.join('+')})`);
                    });
                }
            }
        }
        catch (error) {
            console.error("Search failed:", error);
            process.exit(1);
        }
    });
    // Memory statistics
    memory
        .command("stats")
        .description("Show memory statistics")
        .option("--scope <scope>", "Stats for specific scope")
        .option("--json", "Output as JSON")
        .option("--clean-json", "Plugin-side clean JSON mode; use with --json under the OpenClaw wrapper")
        .option("--quiet", "Plugin-side quiet JSON mode; use with --json under the OpenClaw wrapper")
        .action(async (options) => {
        try {
            let scopeFilter;
            if (options.scope) {
                scopeFilter = [options.scope];
            }
            const stats = await context.store.stats(scopeFilter);
            const scopeStats = context.scopeManager.getStats();
            const retrievalConfig = context.retriever.getConfig();
            const diagnostics = context.store.getDiagnostics();
            const summary = {
                memory: stats,
                scopes: scopeStats,
                retrieval: {
                    mode: retrievalConfig.mode,
                    hasFtsSupport: context.store.hasFtsSupport,
                },
                diagnostics,
            };
            if (options.json || options.cleanJson || options.quiet) {
                writeJson(summary);
            }
            else {
                console.log(`Memory Statistics:`);
                console.log(`• Total memories: ${stats.totalCount}`);
                console.log(`• Available scopes: ${scopeStats.totalScopes}`);
                console.log(`• Retrieval mode: ${retrievalConfig.mode}`);
                console.log(`• FTS support: ${context.store.hasFtsSupport ? 'Yes' : 'No'}`);
                console.log(`• SQL truth: ${diagnostics.sqlTruth.available ? `Yes (${diagnostics.sqlTruth.count} rows, FTS ${diagnostics.sqlTruth.fts?.healthy ? 'healthy' : 'needs repair'})` : 'No'}`);
                console.log(`• Vector companion: ${diagnostics.vectorCompanion.backend} ${diagnostics.vectorCompanion.needsRepair ? `needs repair (${diagnostics.vectorCompanion.message})` : 'ready'}`);
                console.log();
                console.log("Memories by scope:");
                Object.entries(stats.scopeCounts).forEach(([scope, count]) => {
                    console.log(`  • ${scope}: ${count}`);
                });
                console.log();
                console.log("Memories by category:");
                Object.entries(stats.categoryCounts).forEach(([category, count]) => {
                    console.log(`  • ${category}: ${count}`);
                });
            }
        }
        catch (error) {
            console.error("Failed to get statistics:", error);
            process.exit(1);
        }
    });
    memory
        .command("doctor")
        .description("Run read-only diagnostics for SQL truth, LanceDB vector companion, FTS, and scope distribution")
        .option("--json", "Output as JSON")
        .option("--clean-json", "Plugin-side clean JSON mode; use with --json under the OpenClaw wrapper")
        .option("--quiet", "Plugin-side quiet JSON mode; use with --json under the OpenClaw wrapper")
        .action(async (options) => {
        try {
            const stats = await context.store.stats();
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
            const issues = [];
            if (!diagnostics.sqlTruth.available) {
                issues.push(`SQL truth unavailable${diagnostics.sqlTruth.error ? `: ${diagnostics.sqlTruth.error}` : ""}`);
            }
            if (diagnostics.sqlTruth.fts && !diagnostics.sqlTruth.fts.healthy) {
                issues.push(`SQL truth FTS needs repair: ${diagnostics.sqlTruth.fts.reason ?? "unknown"}`);
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
                fts: diagnostics.fts,
                vectorCompanion: {
                    ...diagnostics.vectorCompanion,
                    drift: vectorDrift,
                },
                scopes: {
                    configured: scopeStats,
                    sqlTruthCounts: stats.scopeCounts,
                    vectorCounts: vectorScopeCounts,
                    sqlVectorScopeMatch,
                    warnings: scopeWarnings,
                },
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
            console.log(`• Vector backend: ${diagnostics.vectorCompanion.backend}`);
            console.log(`• Vector dimension: ${diagnostics.vectorCompanion.configuredDimension}`);
            console.log(`• Vector rows: ${vectorDrift.vectorRows}`);
            console.log(`• Missing vector rows: ${vectorDrift.missingVectorRows}`);
            console.log(`• Stale vector rows: ${vectorDrift.staleVectorRows}`);
            console.log(`• Scope distribution match: ${sqlVectorScopeMatch ? "yes" : "no"}`);
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
            console.error("Vector repair failed:", error);
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
            console.error("Dashboard failed:", error);
            process.exit(1);
        }
    });
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
            console.error("Candidate report failed:", error);
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
            console.error("Candidate promotion failed:", error);
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
            console.error("Digest report failed:", error);
            process.exit(1);
        }
    });
    digest
        .command("run")
        .description("Run OpenClaw-native digest extraction; dry-run by default")
        .option("--text <text>", "Explicit digest input text")
        .option("--input-file <path>", "Read digest input text from a file")
        .option("--scope <scope>", "Target memory scope", "agent:main")
        .option("--max-chunks <n>", "Maximum reflection chunks when no explicit input is provided", "25")
        .option("--use-llm", "Use configured LLM extraction before heuristic fallback")
        .option("--no-llm-fallback", "Disable heuristic fallback after LLM extraction")
        .option("--apply", "Write digest candidates to SQL truth and vector companion")
        .option("--dry-run", "Preview without writing; wins over --apply")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const db = await getSqlDbOrThrow();
            const dryRun = dryRunFromApplyOptions(options);
            let inputText = typeof options.text === "string" ? options.text : undefined;
            if (typeof options.inputFile === "string" && options.inputFile.trim()) {
                inputText = await readFile(path.resolve(options.inputFile.trim()), "utf8");
            }
            const result = await runDigestPipeline(db, {
                apply: !dryRun,
                scope: typeof options.scope === "string" && options.scope.trim() ? options.scope.trim() : "agent:main",
                inputText,
                sourceId: typeof options.inputFile === "string" && options.inputFile.trim()
                    ? path.resolve(options.inputFile.trim())
                    : inputText
                        ? "cli-text"
                        : undefined,
                sourceType: inputText ? "explicit" : "reflection_event",
                maxChunks: parseLimitOption(options.maxChunks, 25, 200),
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
                writeJson(result);
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
            if (result.errors.length > 0) {
                console.log(`• Errors: ${result.errors.length}`);
                process.exitCode = 1;
            }
        }
        catch (error) {
            console.error("Digest run failed:", error);
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
            console.error("Digest recovery failed:", error);
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
            console.error("Governance cleanup failed:", error);
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
            console.error("Governance rollback failed:", error);
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
            console.error("Governance audit coverage failed:", error);
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
            console.error("Journal recovery failed:", error);
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
            console.error("Graph hygiene failed:", error);
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
            console.error("Forgetting report failed:", error);
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
            console.error("Forgetting run failed:", error);
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
            console.error("Auto recall trace listing failed:", error);
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
                if (options.json)
                    writeJson(payload);
                else
                    console.log("Experience Kernel tables are not initialized.");
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
        }
        catch (error) {
            console.error("Experience stats failed:", error);
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
        }
        catch (error) {
            console.error("Experience debt report failed:", error);
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
        }
        catch (error) {
            console.error("Experience promotion failed:", error);
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
            if (!result.dry_run)
                console.log(`• Backup hint: ${result.backup_hint}`);
        }
        catch (error) {
            console.error("Experience promotion batch failed:", error);
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
        }
        catch (error) {
            console.error("Experience bridge draft generation failed:", error);
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
                if (options.json)
                    writeJson(payload);
                else
                    console.log("Experience Kernel tables are not initialized.");
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
        }
        catch (error) {
            console.error("Experience replay failed:", error);
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
                if (options.json)
                    writeJson(payload);
                else
                    console.log("Experience Kernel tables are not initialized.");
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
        }
        catch (error) {
            console.error("Playbook list failed:", error);
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
                action: String(options.action),
                reason: typeof options.reason === "string" ? options.reason : undefined,
                supersededBy: typeof options.supersededBy === "string" ? options.supersededBy : undefined,
            });
            if (options.json) {
                writeJson(result);
                return;
            }
            if (!result.reviewed) {
                console.error(`Playbook review failed: ${result.error}`);
                process.exit(1);
            }
            console.log(`Playbook ${result.id} updated to ${result.status} (version ${result.version})`);
        }
        catch (error) {
            console.error("Playbook review failed:", error);
            process.exit(1);
        }
    });
    for (const action of ["promote", "quarantine"]) {
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
                    console.error(`Playbook ${action} failed: ${result.error}`);
                    process.exit(1);
                }
                console.log(`Playbook ${result.id} updated to ${result.status} (version ${result.version})`);
            }
            catch (error) {
                console.error(`Playbook ${action} failed:`, error);
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
                console.error(`Playbook supersede failed: ${result.error}`);
                process.exit(1);
            }
            console.log(`Playbook ${result.id} superseded by ${options.supersededBy} (version ${result.version})`);
        }
        catch (error) {
            console.error("Playbook supersede failed:", error);
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
            let scopeFilter;
            if (options.scope) {
                scopeFilter = [options.scope];
            }
            const deleted = await context.store.delete(id, scopeFilter);
            if (deleted) {
                console.log(`Memory ${id} deleted successfully.`);
            }
            else {
                console.log(`Memory ${id} not found or access denied.`);
                process.exit(1);
            }
        }
        catch (error) {
            console.error("Failed to delete memory:", error);
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
            let beforeTimestamp;
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
            }
            else {
                const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
                console.log(`Deleted ${deletedCount} memories.`);
            }
        }
        catch (error) {
            console.error("Bulk delete failed:", error);
            process.exit(1);
        }
    });
    // Export memories
    memory
        .command("export")
        .description("Export memories to JSON")
        .option("--scope <scope>", "Export specific scope")
        .option("--category <category>", "Export specific category")
        .option("--output <file>", "Output file (default: stdout)")
        .action(async (options) => {
        try {
            let scopeFilter;
            if (options.scope) {
                scopeFilter = [options.scope];
            }
            const memories = await context.store.list(scopeFilter, options.category, 1000 // Large limit for export
            );
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
                const fs = await import("node:fs/promises");
                await fs.writeFile(options.output, output);
                console.log(`Exported ${memories.length} memories to ${options.output}`);
            }
            else {
                console.log(output);
            }
        }
        catch (error) {
            console.error("Export failed:", error);
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
                    const category = categoryRaw === "preference" ||
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
                    const metadata = typeof metadataRaw === "string"
                        ? metadataRaw
                        : metadataRaw != null
                            ? JSON.stringify(metadataRaw)
                            : "{}";
                    const idRaw = memory.id;
                    const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;
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
                    }
                    else {
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
                }
                catch (error) {
                    console.warn(`Failed to import memory: ${error}`);
                    skipped++;
                }
            }
            console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
        }
        catch (error) {
            console.error("Import failed:", error);
            process.exit(1);
        }
    });
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
            const fs = await import("node:fs/promises");
            const sourceDbPath = options.sourceDb;
            const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
            const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1000000) : undefined;
            const dryRun = options.dryRun === true;
            const skipExisting = options.skipExisting === true;
            const force = options.force === true;
            // Safety: prevent accidental in-place re-embedding
            let sourceReal = sourceDbPath;
            let targetReal = context.store.dbPath;
            try {
                sourceReal = await fs.realpath(sourceDbPath);
            }
            catch { }
            try {
                targetReal = await fs.realpath(context.store.dbPath);
            }
            catch { }
            if (!force && sourceReal === targetReal) {
                console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
                process.exit(1);
            }
            const lancedb = await loadLanceDB();
            const db = await lancedb.connect(sourceDbPath);
            const table = await db.openTable("memories");
            let query = table
                .query()
                .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]);
            if (limit)
                query = query.limit(limit);
            const rows = (await query.toArray())
                .filter((r) => r && typeof r.text === "string" && r.text.trim().length > 0)
                .filter((r) => r.id && r.id !== "__schema__");
            if (rows.length === 0) {
                console.log("No source memories found.");
                return;
            }
            console.log(`Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`);
            if (dryRun) {
                console.log("DRY RUN - No memories will be written");
                console.log(`First example: ${rows[0].id?.slice?.(0, 8)} ${String(rows[0].text).slice(0, 80)}`);
                return;
            }
            let processed = 0;
            let imported = 0;
            let skipped = 0;
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const texts = batch.map((r) => String(r.text));
                const vectors = await context.embedder.embedBatchPassage(texts);
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
                    const entry = {
                        id,
                        text: String(row.text),
                        vector,
                        category: row.category || "other",
                        scope: row.scope || "global",
                        importance: (row.importance != null) ? Number(row.importance) : 0.7,
                        timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
                        metadata: typeof row.metadata === "string" ? row.metadata : "{}",
                    };
                    await context.store.importEntry(entry);
                    imported++;
                }
                if (processed % 100 === 0 || processed === rows.length) {
                    console.log(`Progress: ${processed}/${rows.length} processed, ${imported} imported, ${skipped} skipped`);
                }
            }
            console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
        }
        catch (error) {
            console.error("Re-embed failed:", error);
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
            const upgrader = createMemoryUpgrader(context.store, options.llm === false ? null : (context.llmClient ?? null), { log: console.log });
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
        }
        catch (error) {
            console.error("Upgrade failed:", error);
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
        }
        catch (error) {
            console.error("Migration check failed:", error);
            process.exit(1);
        }
    });
    migrate
        .command("run")
        .description("Run migration from legacy memory-lancedb")
        .option("--source <path>", "Specific source database path")
        .option("--default-scope <scope>", "Default scope for migrated data", "global")
        .option("--dry-run", "Show what would be migrated without actually migrating")
        .option("--skip-existing", "Skip entries that already exist")
        .action(async (options) => {
        try {
            const result = await context.migrator.migrate({
                sourceDbPath: options.source,
                defaultScope: options.defaultScope,
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
        }
        catch (error) {
            console.error("Migration failed:", error);
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
        }
        catch (error) {
            console.error("Verification failed:", error);
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
            }
            else {
                console.error("❌ FTS rebuild failed:", result.error);
                process.exit(1);
            }
        }
        catch (error) {
            console.error("FTS rebuild error:", error);
            process.exit(1);
        }
    });
}
// ============================================================================
// Factory Function
// ============================================================================
export function createMemoryCLI(context) {
    return ({ program }) => registerMemoryCLI(program, context);
}
