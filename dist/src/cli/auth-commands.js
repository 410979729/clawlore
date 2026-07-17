/**
 * CLI Commands for Memory Management
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { getDefaultOauthModelForProvider, getOAuthProviderLabel, normalizeOAuthProviderId, normalizeOauthModel, performOAuthLogin } from "../llm-oauth.js";
import { readOAuthSessionFile } from "../oauth-session-storage.js";
import { CLAWLORE_PLUGIN_ID } from "../product-identity.js";
import { inspectLegacyAuthorityMigration, migrateLegacySqlAuthority, } from "../sql-authority-migration.js";
import { SqlTruthStore } from "../sql-truth-store.js";
import { OAUTH_PROVIDER_CHOICES, buildLogoutFallbackLlmConfig, clampInt, ensurePluginConfigRoot, extractOauthSafeLlmConfig, getExistingPluginConfigRoot, getOauthBackupPath, getPluginVersion, hasRestorableApiKeyLlmConfig, isOauthLlmConfig, isPlainObject, loadOauthLlmBackup, loadOpenClawConfig, pickOauthModel, resolveConfiguredOauthPath, resolveLoginOauthPath, resolveOauthProviderSelection, resolveOpenClawConfigPath, saveOauthLlmBackup, saveOpenClawConfig, writeJson } from "./cli-runtime-policy.js";
export function registerAuthCommands(runtime) {
    const { program, memory, context, runSearch, getSqlDbOrThrow, parseScopeFilter, parseLimitOption, dryRunFromApplyOptions, loadKnowledgeDocs, hasTables, requireExperienceTables, } = runtime;
    // Version
    memory
        .command("version")
        .description("Print plugin version")
        .action(() => {
        console.log(getPluginVersion());
    });
    const authority = memory
        .command("authority")
        .description("Inspect or explicitly migrate the SQL truth authority");
    authority
        .command("inspect")
        .requiredOption("--db <path>", "Explicit memory.sqlite3 path")
        .option("--json", "Output as JSON")
        .action((options) => {
        try {
            const inspection = SqlTruthStore.inspectAuthority(path.resolve(options.db));
            if (options.json)
                writeJson(inspection);
            else {
                console.log(`Authority: ${inspection.status}`);
                console.log(`Reason: ${inspection.reason}`);
                console.log(`Schema version: ${inspection.schemaVersion ?? "unknown"}`);
                console.log(`Truth rows: ${inspection.truthRows ?? "unknown"}`);
            }
            if (inspection.status !== "valid" && inspection.status !== "legacy")
                process.exitCode = 1;
        }
        catch (error) {
            console.error(`Authority inspection failed: ${diagnosticErrorSummary(error)}`);
            process.exitCode = 1;
        }
    });
    authority
        .command("migrate")
        .requiredOption("--db <path>", "Explicit memory.sqlite3 path")
        .requiredOption("--backup <path>", "New verified SQLite backup path")
        .requiredOption("--receipt <path>", "New private migration receipt path")
        .option("--apply", "Apply the migration; without this flag the command is dry-run")
        .option("--json", "Output as JSON")
        .action(async (options) => {
        try {
            const params = {
                sqlitePath: path.resolve(options.db),
                backupPath: path.resolve(options.backup),
                receiptPath: path.resolve(options.receipt),
            };
            if (!options.apply) {
                const plan = inspectLegacyAuthorityMigration(params);
                if (options.json)
                    writeJson({ dryRun: true, ...plan });
                else
                    console.log(`DRY-RUN authority migration: ${plan.status} (${plan.reason})`);
                if (plan.status !== "ready" && plan.status !== "recoverable")
                    process.exitCode = 1;
                return;
            }
            const receipt = await migrateLegacySqlAuthority(params);
            if (options.json)
                writeJson(receipt);
            else {
                console.log(`Authority migration: ${receipt.status}`);
                console.log(`Migration id: ${receipt.migrationId}`);
                console.log(`Truth rows: ${receipt.sourceTruthRows}`);
                console.log(`Backup SHA-256: ${receipt.backupSha256}`);
                console.log(`Source snapshot SHA-256: ${receipt.sourceSnapshotSha256}`);
            }
        }
        catch (error) {
            console.error(`Authority migration failed: ${diagnosticErrorSummary(error)}`);
            process.exitCode = 1;
        }
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
                const session = await readOAuthSessionFile(oauthPath);
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
}
