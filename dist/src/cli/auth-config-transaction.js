import JSON5 from "json5";
import { existsSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivateFile, writePrivateFileAtomic, } from "../file-privacy.js";
import { CLAWLORE_LEGACY_DEFAULTS, CLAWLORE_LEGACY_PLUGIN_IDS, CLAWLORE_PLUGIN_ID, } from "../product-identity.js";
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
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isOauthLlmConfig(value) {
    return isPlainObject(value) && value.auth === "oauth";
}
function parseSecretRef(value) {
    if (!isPlainObject(value)) {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_REQUIRES_SECRETREF");
    }
    const keys = Object.keys(value).sort();
    if (!isDeepStrictEqual(keys, ["id", "provider", "source"])) {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_SECRETREF_INVALID");
    }
    if (value.source !== "env" && value.source !== "file" && value.source !== "exec") {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_SECRETREF_INVALID");
    }
    if (typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider)) {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_SECRETREF_INVALID");
    }
    if (typeof value.id !== "string") {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_SECRETREF_INVALID");
    }
    const idIsValid = value.source === "env"
        ? ENV_SECRET_REF_ID_PATTERN.test(value.id)
        : value.source === "file"
            ? value.id === "value" || (value.id.startsWith("/") &&
                value.id.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment)))
            : EXEC_SECRET_REF_ID_PATTERN.test(value.id) &&
                value.id.split("/").every((segment) => segment !== "." && segment !== "..");
    if (!idIsValid) {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_SECRETREF_INVALID");
    }
    return { source: value.source, provider: value.provider, id: value.id };
}
export function extractRestorableApiKeyLlmConfig(value) {
    if (!isPlainObject(value)) {
        return {};
    }
    const allowedKeys = new Set(["auth", "apiKey", "model", "baseURL", "timeoutMs"]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_CONFIG_INVALID");
    }
    const result = {};
    if (value.auth !== undefined && value.auth !== "api-key") {
        throw new Error("CLAWLORE_OAUTH_API_KEY_BACKUP_AUTH_INVALID");
    }
    if (value.auth === "api-key") {
        result.auth = "api-key";
    }
    if (Object.hasOwn(value, "apiKey")) {
        result.apiKey = parseSecretRef(value.apiKey);
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
export function buildOauthLlmBackup(llm, hadLlmConfig) {
    return {
        version: 2,
        hadLlmConfig,
        llm: hadLlmConfig ? extractRestorableApiKeyLlmConfig(llm) : {},
    };
}
export function planOAuthLoginConfig(options) {
    const previousLlm = isPlainObject(options.llm) ? { ...options.llm } : {};
    const hadLlmConfig = isPlainObject(options.llm);
    const wasOauthMode = isOauthLlmConfig(previousLlm);
    if (!wasOauthMode) {
        buildOauthLlmBackup(options.llm, hadLlmConfig);
    }
    const nextLlm = wasOauthMode
        ? { ...previousLlm }
        : extractOauthSafeLlmConfig(previousLlm);
    if (!wasOauthMode)
        delete nextLlm.baseURL;
    return {
        hadLlmConfig,
        wasOauthMode,
        previousLlm,
        nextLlm: {
            ...nextLlm,
            auth: "oauth",
            oauthProvider: options.providerId,
            model: options.model,
            oauthPath: options.oauthPath,
        },
    };
}
function comparablePath(value) {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export async function prepareOAuthLoginBackup(options) {
    if (!options.loginPlan.wasOauthMode) {
        return {
            writeBackup: true,
            hadLlmConfig: options.loginPlan.hadLlmConfig,
            llm: options.loginPlan.previousLlm,
        };
    }
    const sourceOauthPath = resolveConfiguredOauthPath(options.configPath, options.loginPlan.previousLlm.oauthPath);
    const existingBackup = await loadOauthLlmBackup(sourceOauthPath);
    if (!existingBackup) {
        throw new Error("CLAWLORE_OAUTH_RELOGIN_BACKUP_REQUIRED");
    }
    return {
        writeBackup: comparablePath(sourceOauthPath) !== comparablePath(options.targetOauthPath),
        hadLlmConfig: existingBackup.hadLlmConfig,
        llm: existingBackup.llm,
        sourceOauthPath,
    };
}
export async function saveOauthLlmBackup(oauthPath, llm, hadLlmConfig) {
    const backupPath = getOauthBackupPath(oauthPath);
    const payload = buildOauthLlmBackup(llm, hadLlmConfig);
    await writePrivateFileAtomic(backupPath, JSON.stringify(payload, null, 2) + "\n");
}
export async function loadOauthLlmBackup(oauthPath) {
    const backupPath = getOauthBackupPath(oauthPath);
    let raw;
    try {
        raw = await readPrivateFile(backupPath);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return null;
        throw new Error("CLAWLORE_OAUTH_LLM_BACKUP_READ_FAILED", { cause: error });
    }
    try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed) ||
            !isDeepStrictEqual(Object.keys(parsed).sort(), ["hadLlmConfig", "llm", "version"]) ||
            parsed.version !== 2 ||
            typeof parsed.hadLlmConfig !== "boolean" ||
            !isPlainObject(parsed.llm)) {
            throw new Error("invalid backup envelope");
        }
        const llm = parsed.hadLlmConfig ? extractRestorableApiKeyLlmConfig(parsed.llm) : {};
        if (!parsed.hadLlmConfig && (!isPlainObject(parsed.llm) || Object.keys(parsed.llm).length !== 0)) {
            throw new Error("unexpected llm payload without prior config");
        }
        return {
            version: 2,
            hadLlmConfig: parsed.hadLlmConfig,
            llm,
        };
    }
    catch (error) {
        throw new Error("CLAWLORE_OAUTH_LLM_BACKUP_INVALID", { cause: error });
    }
}
export async function loadOpenClawConfig(configPath) {
    const raw = await readPrivateFile(configPath);
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid OpenClaw config at ${configPath}: expected object`);
    }
    return parsed;
}
function pluginIdentityContainers(config) {
    if (config.plugins === undefined)
        config.plugins = {};
    if (!isPlainObject(config.plugins)) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins must be an object");
    }
    const plugins = config.plugins;
    if (plugins.entries === undefined)
        plugins.entries = {};
    if (!isPlainObject(plugins.entries)) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins.entries must be an object");
    }
    return { plugins, entries: plugins.entries };
}
function assertPluginEntry(value, id) {
    if (!isPlainObject(value)) {
        throw new Error(`CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: ${id} entry must be an object`);
    }
    if (value.config !== undefined && !isPlainObject(value.config)) {
        throw new Error(`CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: ${id} config must be an object`);
    }
}
function canonicalizePluginIdentityReferences(plugins) {
    if (plugins.allow !== undefined) {
        if (!Array.isArray(plugins.allow) || plugins.allow.some((value) => typeof value !== "string")) {
            throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins.allow must be a string array");
        }
        const canonicalAllow = plugins.allow.map((id) => CLAWLORE_LEGACY_PLUGIN_IDS.includes(id) ? CLAWLORE_PLUGIN_ID : id);
        plugins.allow = [...new Set(canonicalAllow)];
    }
    if (plugins.slots !== undefined && !isPlainObject(plugins.slots)) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins.slots must be an object");
    }
    if (isPlainObject(plugins.slots) &&
        typeof plugins.slots.memory === "string" &&
        CLAWLORE_LEGACY_PLUGIN_IDS.includes(plugins.slots.memory)) {
        plugins.slots.memory = CLAWLORE_PLUGIN_ID;
    }
}
export function ensurePluginConfigRoot(config, pluginId) {
    const { plugins, entries } = pluginIdentityContainers(config);
    if (pluginId !== CLAWLORE_PLUGIN_ID) {
        entries[pluginId] ||= { enabled: true, config: {} };
        assertPluginEntry(entries[pluginId], pluginId);
        entries[pluginId].config ||= {};
        return entries[pluginId].config;
    }
    const legacyIds = CLAWLORE_LEGACY_PLUGIN_IDS.filter((id) => entries[id] !== undefined);
    if (legacyIds.length > 1) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFLICT: multiple legacy entries are present");
    }
    const legacyId = legacyIds[0];
    const canonicalEntry = entries[CLAWLORE_PLUGIN_ID];
    const legacyEntry = legacyId ? entries[legacyId] : undefined;
    if (canonicalEntry !== undefined)
        assertPluginEntry(canonicalEntry, CLAWLORE_PLUGIN_ID);
    if (legacyEntry !== undefined)
        assertPluginEntry(legacyEntry, legacyId);
    if (canonicalEntry !== undefined && legacyEntry !== undefined && !isDeepStrictEqual(canonicalEntry, legacyEntry)) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFLICT: canonical and legacy entries differ");
    }
    if (plugins.allow !== undefined && (!Array.isArray(plugins.allow) || plugins.allow.some((value) => typeof value !== "string"))) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins.allow must be a string array");
    }
    if (plugins.slots !== undefined && !isPlainObject(plugins.slots)) {
        throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: plugins.slots must be an object");
    }
    if (canonicalEntry === undefined && legacyEntry !== undefined) {
        entries[CLAWLORE_PLUGIN_ID] = legacyEntry;
    }
    else if (canonicalEntry === undefined) {
        entries[CLAWLORE_PLUGIN_ID] = { enabled: true, config: {} };
    }
    if (legacyId)
        delete entries[legacyId];
    canonicalizePluginIdentityReferences(plugins);
    const entry = entries[CLAWLORE_PLUGIN_ID];
    assertPluginEntry(entry, CLAWLORE_PLUGIN_ID);
    entry.config ||= {};
    return entry.config;
}
export function getExistingPluginConfigRoot(config, pluginId) {
    const plugins = isPlainObject(config.plugins) ? config.plugins : {};
    const entries = isPlainObject(plugins.entries) ? plugins.entries : {};
    const hasCanonicalEntry = Object.hasOwn(entries, pluginId);
    if (hasCanonicalEntry && !isPlainObject(entries[pluginId])) {
        throw new Error(`CLAWLORE_PLUGIN_IDENTITY_CONFIG_INVALID: ${pluginId} entry must be an object`);
    }
    let entry = hasCanonicalEntry ? entries[pluginId] : {};
    if (pluginId === CLAWLORE_PLUGIN_ID) {
        const legacyEntries = CLAWLORE_LEGACY_PLUGIN_IDS
            .map((id) => entries[id])
            .filter((value) => value !== undefined);
        if (legacyEntries.length > 1) {
            throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFLICT: multiple legacy entries are present");
        }
        if (hasCanonicalEntry && legacyEntries.length === 1 && !isDeepStrictEqual(entry, legacyEntries[0])) {
            throw new Error("CLAWLORE_PLUGIN_IDENTITY_CONFLICT: canonical and legacy entries differ");
        }
        if (!hasCanonicalEntry && isPlainObject(legacyEntries[0])) {
            entry = legacyEntries[0];
        }
    }
    return isPlainObject(entry.config) ? entry.config : {};
}
export function getOpenClawConfigBackupPath(configPath) {
    return path.join(path.dirname(configPath), ".clawlore", "config-backups", `${path.basename(configPath)}.before-auth.json`);
}
export async function saveOpenClawConfig(configPath, config, hooks = {}) {
    const serialized = JSON.stringify(config, null, 2) + "\n";
    const normalized = JSON.parse(serialized);
    if (!isDeepStrictEqual(normalized, config)) {
        throw new Error("CLAWLORE_OPENCLAW_CONFIG_NOT_JSON_SAFE");
    }
    const previous = await readPrivateFile(configPath, hooks);
    JSON5.parse(previous);
    const backupPath = getOpenClawConfigBackupPath(configPath);
    await hooks.beforeBackupWrite?.();
    await writePrivateFileAtomic(backupPath, previous, {
        platform: hooks.platform,
        execFile: hooks.execFile,
    });
    await hooks.afterBackupWrite?.();
    await writePrivateFileAtomic(configPath, serialized, hooks);
    await hooks.beforePostRenameValidation?.();
    try {
        const persisted = JSON5.parse(await readPrivateFile(configPath, hooks));
        if (!isDeepStrictEqual(persisted, normalized)) {
            throw new Error("CLAWLORE_OPENCLAW_CONFIG_POST_WRITE_MISMATCH");
        }
    }
    catch (error) {
        await writePrivateFileAtomic(configPath, previous, {
            platform: hooks.platform,
            execFile: hooks.execFile,
        }).catch((restoreError) => {
            throw new AggregateError([error, restoreError], "CLAWLORE_OPENCLAW_CONFIG_RESTORE_FAILED");
        });
        throw error;
    }
    return { backupPath };
}
async function syncRemovedFileParent(filePath) {
    if (process.platform === "win32")
        return;
    const handle = await open(path.dirname(filePath), "r");
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function removeRegularFileDurably(filePath) {
    try {
        const status = await lstat(filePath);
        if (status.isSymbolicLink()) {
            throw new Error("CLAWLORE_OAUTH_DELETE_SYMLINK_REJECTED");
        }
        if (!status.isFile()) {
            throw new Error("CLAWLORE_OAUTH_DELETE_TARGET_INVALID");
        }
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return;
        throw error;
    }
    await rm(filePath);
    await syncRemovedFileParent(filePath);
}
export async function performOAuthLogoutConfigTransaction(options) {
    const pluginId = options.pluginId || CLAWLORE_PLUGIN_ID;
    const openclawConfig = await loadOpenClawConfig(options.configPath);
    const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
    const llm = isPlainObject(pluginConfig.llm)
        ? pluginConfig.llm
        : {};
    const oauthPath = typeof options.oauthPathOverride === "string" && options.oauthPathOverride.trim()
        ? resolveLoginOauthPath(options.oauthPathOverride)
        : resolveConfiguredOauthPath(options.configPath, llm.oauthPath);
    const oauthBackupPath = getOauthBackupPath(oauthPath);
    const previousAuth = isOauthLlmConfig(llm) ? "oauth" : "api-key";
    if (previousAuth === "oauth") {
        const backup = await loadOauthLlmBackup(oauthPath);
        if (!backup) {
            throw new Error("CLAWLORE_OAUTH_LOGOUT_BACKUP_REQUIRED");
        }
        if (backup.hadLlmConfig) {
            pluginConfig.llm = { ...backup.llm };
        }
        else {
            delete pluginConfig.llm;
        }
    }
    const { backupPath: configBackupPath } = await saveOpenClawConfig(options.configPath, openclawConfig, options.hooks?.configWrite);
    await options.hooks?.beforeOauthDelete?.();
    await removeRegularFileDurably(oauthPath);
    await options.hooks?.afterOauthDelete?.();
    await options.hooks?.beforeBackupDelete?.();
    await removeRegularFileDurably(oauthBackupPath);
    await options.hooks?.afterBackupDelete?.();
    return { oauthPath, oauthBackupPath, configBackupPath, previousAuth };
}
