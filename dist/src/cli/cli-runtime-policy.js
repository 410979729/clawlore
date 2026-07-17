/**
 * CLI Commands for Memory Management
 */
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { redactDigestReportForDiagnostics, redactDigestRunForDiagnostics, } from "../diagnostics-redaction.js";
import { digestReport } from "../digest-pipeline.js";
import { getDefaultOauthModelForProvider, isOauthModelSupported, listOAuthProviders, normalizeOAuthProviderId } from "../llm-oauth.js";
import { CLAWLORE_LEGACY_DEFAULTS } from "../product-identity.js";
// ============================================================================
// Utility Functions
// ============================================================================
export function getPluginVersion() {
    // This module is two levels below the package root in source and three
    // levels below it after compilation into dist/src/cli.
    for (const relativePath of ["../../package.json", "../../../package.json"]) {
        try {
            const pkgUrl = new URL(relativePath, import.meta.url);
            const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
            if (pkg.version)
                return pkg.version;
        }
        catch {
            // Try the other stable source/compiled layout before failing closed.
        }
    }
    return "unknown";
}
export function clampInt(value, min, max) {
    const n = Number.isFinite(value) ? value : min;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}
export function resolveOpenClawConfigPath(explicit) {
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
export function resolveOpenClawHome() {
    return process.env.OPENCLAW_HOME?.trim()
        ? path.resolve(process.env.OPENCLAW_HOME.trim())
        : path.join(homedir(), ".openclaw");
}
export function resolveDefaultOauthPath() {
    const home = resolveOpenClawHome();
    const canonical = path.join(home, ".clawlore", "oauth.json");
    const legacy = path.join(home, CLAWLORE_LEGACY_DEFAULTS.oauthDirectoryName, "oauth.json");
    return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
}
export function resolveLoginOauthPath(rawPath) {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    const candidate = trimmed || resolveDefaultOauthPath();
    return path.resolve(candidate);
}
export function resolveConfiguredOauthPath(configPath, rawPath) {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!trimmed) {
        return resolveDefaultOauthPath();
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    return path.resolve(path.dirname(configPath), trimmed);
}
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isOauthLlmConfig(value) {
    return isPlainObject(value) && value.auth === "oauth";
}
export function extractRestorableApiKeyLlmConfig(value) {
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
export function extractOauthSafeLlmConfig(value) {
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
export function hasRestorableApiKeyLlmConfig(value) {
    return Object.keys(value).length > 0;
}
export function buildLogoutFallbackLlmConfig(value) {
    if (isOauthLlmConfig(value)) {
        return extractOauthSafeLlmConfig(value);
    }
    return extractRestorableApiKeyLlmConfig(value);
}
export function getOauthBackupPath(oauthPath) {
    const parsed = path.parse(oauthPath);
    const fileName = parsed.ext
        ? `${parsed.name}.llm-backup${parsed.ext}`
        : `${parsed.base}.llm-backup.json`;
    return path.join(parsed.dir, fileName);
}
export async function saveOauthLlmBackup(oauthPath, llm, hadLlmConfig) {
    const backupPath = getOauthBackupPath(oauthPath);
    const payload = {
        version: 1,
        hadLlmConfig,
        llm: extractRestorableApiKeyLlmConfig(llm),
    };
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
export async function loadOauthLlmBackup(oauthPath) {
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
export const OAUTH_PROVIDER_CHOICES = listOAuthProviders()
    .map((provider) => `${provider.id} (${provider.label})`)
    .join(", ");
export function pickOauthProvider(currentProvider, overrideProvider) {
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
export async function promptOauthProviderSelection(currentProviderId, testHook) {
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
export async function resolveOauthProviderSelection(currentProvider, overrideProvider, chooseProviderHook) {
    if (overrideProvider && overrideProvider.trim()) {
        return pickOauthProvider(currentProvider, overrideProvider);
    }
    const initial = pickOauthProvider(currentProvider, undefined);
    return await promptOauthProviderSelection(initial.providerId, chooseProviderHook);
}
export function pickOauthModel(providerId, currentModel, overrideModel) {
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
export async function loadOpenClawConfig(configPath) {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid OpenClaw config at ${configPath}: expected object`);
    }
    return parsed;
}
export function ensurePluginConfigRoot(config, pluginId) {
    config.plugins ||= {};
    config.plugins.entries ||= {};
    config.plugins.entries[pluginId] ||= { enabled: true, config: {} };
    const entry = config.plugins.entries[pluginId];
    entry.enabled = true;
    entry.config ||= {};
    return entry.config;
}
export function getExistingPluginConfigRoot(config, pluginId) {
    const plugins = isPlainObject(config.plugins) ? config.plugins : {};
    const entries = isPlainObject(plugins.entries) ? plugins.entries : {};
    const entry = isPlainObject(entries[pluginId]) ? entries[pluginId] : {};
    return isPlainObject(entry.config) ? entry.config : {};
}
export async function saveOpenClawConfig(configPath, config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
export function formatMemory(memory, index) {
    const prefix = index !== undefined ? `${index + 1}. ` : "";
    const id = memory?.id ? String(memory.id) : "unknown";
    const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
    const fullText = String(memory.text || "");
    const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
    return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}
export function formatJson(obj) {
    return JSON.stringify(obj, null, 2);
}
export function writeJson(obj) {
    process.stdout.write(`${formatJson(obj)}\n`);
}
export function stableRecordEntries(record) {
    return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}
export function tableNames(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all();
    return new Set(rows.map((row) => String(row.name)));
}
export function groupedCounts(db, sql) {
    const rows = db.prepare(sql).all();
    return Object.fromEntries(rows.map((row) => [String(row.key || ""), Number(row.count || 0)]));
}
export function collectExperienceHealth(db) {
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
export function collectNightlyDigestHealth(db) {
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
export function recordsEqual(a, b) {
    return JSON.stringify(stableRecordEntries(a)) === JSON.stringify(stableRecordEntries(b));
}
export async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}
