/**
 * ClawLore memory plugin for OpenClaw.
 * SQLite-backed long-term memory with hybrid retrieval and multi-scope isolation.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dirname, join } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

// Detect CLI/runtime registration mode from the plugin API instead of relying on
// process-global environment flags. Gateway plugin loading can evaluate code in the
// same process family as CLI helpers during reload/restart, so OPENCLAW_CLI is too
// blunt for deciding whether to short-circuit runtime registration.
const isClawLoreCliInvocation = () => {
  const args = process.argv.slice(2);
  return args.includes(CLAWLORE_CLI_PRIMARY) || CLAWLORE_CLI_ALIASES.some((name) => args.includes(name));
};

const isCliRegistrationMode = (api: Pick<OpenClawPluginApi, "registrationMode">) =>
  api.registrationMode === "cli-metadata" || isClawLoreCliInvocation();

// Import core components
import { MemoryStore } from "./src/store.js";
import { createMemoryCLI } from "./cli.js";
import {
  CLAWLORE_CLI_ALIASES,
  CLAWLORE_CLI_PRIMARY,
  CLAWLORE_DESCRIPTION,
  CLAWLORE_PLUGIN_ID,
  CLAWLORE_PRODUCT_NAME,
} from "./src/product-identity.js";
import { parsePluginConfig, parseRuntimePluginConfig, type PluginConfig } from "./src/plugin-config.js";
export { parsePluginConfig };
import { createEmbedder } from "./src/embedder.js";
import { createRetriever } from "./src/retriever.js";
import { createScopeManager, parseAgentIdFromSessionKey } from "./src/scopes.js";
import { createMigrator } from "./src/migrate.js";
import { registerAllMemoryTools } from "./src/tools.js";
import {
  runCompaction,
  shouldRunCompaction,
  type CompactionConfig,
} from "./src/memory-compactor.js";
import {
  shouldSkipReflectionMessage,
} from "./src/reflection-transcript.js";
export { readSessionConversationWithResetFallback } from "./src/reflection-transcript.js";
export { detectCategory, shouldCapture } from "./src/auto-capture-policy.js";
import { AutoCaptureSessionState } from "./src/auto-capture-session-state.js";
import {
  diagnosticContentSummary,
  diagnosticErrorSummary,
  diagnosticHash,
  diagnosticIdentifier,
  diagnosticTextSummary,
} from "./src/diagnostic-redaction.js";

// Import smart extraction & lifecycle components
import { SmartExtractor, createExtractionRateLimiter } from "./src/smart-extractor.js";
import { NoisePrototypeBank } from "./src/noise-prototypes.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";
import { registerExperienceTools } from "./src/experience-tools.js";
import { resolveRuntimeMemoryAccess } from "./src/runtime-memory-boundary.js";
import {
  resolveRejectedAuditFilePath,
  type AdmissionRejectionAuditEntry,
} from "./src/admission-control.js";
import { ensureExperienceSchema } from "./src/experience-store.js";
import { registerMarkdownCompatibility } from "./src/markdown-compat.js";
import { createMdMirrorWriter } from "./src/markdown-mirror.js";
import {
  createConfiguredLlmRuntime,
  createCoreMemoryRuntime,
  getDefaultWorkspaceDir,
  resolveCliPluginConfig,
} from "./src/core-memory-runtime.js";
import { registerClawLoreShadowRuntime } from "./src/runtime-shadow-registration.js";
import { ReflectionRuntimeState } from "./src/reflection-runtime-state.js";
import { registerAutoRecallHooks } from "./src/auto-recall-hooks.js";
import { registerAutoCaptureHooks } from "./src/auto-capture-hooks.js";
import { registerTaskExperienceHooks } from "./src/task-experience-hooks.js";
import { registerSelfImprovementHooks } from "./src/self-improvement-hooks.js";
import { registerReflectionHooks } from "./src/reflection-hooks.js";

// ============================================================================
// Default Configuration
// ============================================================================

function resolveWorkspaceDirFromContext(context: Record<string, unknown> | undefined): string {
  const runtimePath = typeof context?.workspaceDir === "string" ? context.workspaceDir.trim() : "";
  return runtimePath || getDefaultWorkspaceDir();
}

function resolveHookAgentId(
  explicitAgentId: string | undefined,
  sessionKey: string | undefined,
): string {
  const trimmedExplicit = explicitAgentId?.trim();
  return (trimmedExplicit && trimmedExplicit.length > 0
    ? trimmedExplicit
    : parseAgentIdFromSessionKey(sessionKey)) || "main";
}

const DEFAULT_REFLECTION_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS = 200;
const DIAG_BUILD_TAG_PREFIX = "clawlore";

function isInternalReflectionSessionKey(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().startsWith("temp:memory-reflection");
}

function summarizeMessageContent(content: unknown): string {
  return diagnosticContentSummary(content);
}

// ============================================================================
// Admission Control Audit Writer
// ============================================================================

function createAdmissionRejectionAuditWriter(
  config: PluginConfig,
  resolvedDbPath: string,
  api: OpenClawPluginApi,
): ((entry: AdmissionRejectionAuditEntry) => Promise<void>) | null {
  if (
    config.admissionControl?.enabled !== true ||
    config.admissionControl.persistRejectedAudits !== true
  ) {
    return null;
  }

  const filePath = api.resolvePath(
    resolveRejectedAuditFilePath(resolvedDbPath, config.admissionControl),
  );

  return async (entry: AdmissionRejectionAuditEntry) => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      api.logger.warn(`clawlore: admission rejection audit write failed: ${diagnosticErrorSummary(err)}`);
    }
  };
}

// ============================================================================
// Version
// ============================================================================

function getPluginVersion(): string {
  for (const relativePath of ["./package.json", "../package.json"]) {
    try {
      const pkgUrl = new URL(relativePath, import.meta.url);
      const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    } catch {
      // Try the next location. Source loads from index.ts; runtime loads from dist/index.js.
    }
  }
  return "unknown";
}

const pluginVersion = getPluginVersion();
const diagnosticBuildTag = `${DIAG_BUILD_TAG_PREFIX}-${pluginVersion}`;

function registerCliMetadata(api: OpenClawPluginApi): void {
  let initialized = false;
  const context = {
    store: undefined as unknown as MemoryStore,
    retriever: undefined as unknown as ReturnType<typeof createRetriever>,
    scopeManager: undefined as unknown as ReturnType<typeof createScopeManager>,
    migrator: undefined as unknown as ReturnType<typeof createMigrator>,
    embedder: undefined as unknown as ReturnType<typeof createEmbedder>,
    llmClient: undefined as ReturnType<typeof createCoreMemoryRuntime>["cliLlmClient"],
    pluginId: CLAWLORE_PLUGIN_ID,
    pluginConfig: (api.pluginConfig ?? {}) as Record<string, unknown>,
    beforeAction: async (commandPath: string[]) => {
      const root = commandPath[0];
      if (root === "version" || root === "auth" || root === "authority" || initialized) return;
      const runtime = createCoreMemoryRuntime(api, await resolveCliPluginConfig(api));
      context.store = runtime.store;
      context.retriever = runtime.retriever;
      context.scopeManager = runtime.scopeManager;
      context.migrator = runtime.migrator;
      context.embedder = runtime.embedder;
      context.llmClient = runtime.cliLlmClient;
      context.pluginConfig = runtime.config as unknown as Record<string, unknown>;
      initialized = true;
    },
  };

  api.registerCli(createMemoryCLI(context), {
    commands: [CLAWLORE_CLI_PRIMARY, ...CLAWLORE_CLI_ALIASES],
  });
}

// ============================================================================
// Plugin Definition
// ============================================================================

const clawLorePlugin = {
  id: CLAWLORE_PLUGIN_ID,
  name: CLAWLORE_PRODUCT_NAME,
  version: pluginVersion,
  description: CLAWLORE_DESCRIPTION,
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    if (isCliRegistrationMode(api)) {
      registerCliMetadata(api);
      return;
    }

    // Assert OpenClaw's SecretRef materialization contract before strict runtime parsing.
    const config = parseRuntimePluginConfig(api.pluginConfig);
    const {
      resolvedDbPath,
      embeddingModel,
      store,
      embedder,
      retriever,
      scopeManager,
      migrator,
      cliLlmClient,
    } = createCoreMemoryRuntime(api, config);

    api.registerCli(
      createMemoryCLI({
        store,
        retriever,
        scopeManager,
        migrator,
        embedder,
        llmClient: cliLlmClient,
      }),
      { commands: [CLAWLORE_CLI_PRIMARY, ...CLAWLORE_CLI_ALIASES] },
    );

    registerMarkdownCompatibility({
      api,
      resolvedDbPath,
      embeddingModel,
      pluginVersion,
    });

    // Initialize smart extraction
    let smartExtractor: SmartExtractor | null = null;
    let llmClientForExtraction: ReturnType<typeof createConfiguredLlmRuntime>["client"] | null = null;
    if (config.smartExtraction === true) {
      try {
        const { client: llmClient, model: llmModel, timeoutMs: llmTimeoutMs } =
          createConfiguredLlmRuntime(api, config);
        llmClientForExtraction = llmClient;

        // Initialize embedding-based noise prototype bank (async, non-blocking)
        const noiseBank = new NoisePrototypeBank(
          (msg: string) => api.logger.debug(msg),
        );
        noiseBank.init(embedder).catch((err) =>
          api.logger.debug(`clawlore: noise bank init: ${diagnosticErrorSummary(err)}`),
        );

        const admissionRejectionAuditWriter = createAdmissionRejectionAuditWriter(
          config,
          resolvedDbPath,
          api,
        );

        smartExtractor = new SmartExtractor(store, embedder, llmClient, {
          user: "User",
          extractMinMessages: config.extractMinMessages ?? 4,
          extractMaxChars: config.extractMaxChars ?? 8000,
          defaultScope: config.scopes?.default ?? "global",
          workspaceBoundary: config.workspaceBoundary,
          admissionControl: config.admissionControl,
          onAdmissionRejected: admissionRejectionAuditWriter ?? undefined,
          log: (msg: string) => api.logger.info(msg),
          debugLog: (msg: string) => api.logger.debug(msg),
          noiseBank,
        });

        (isCliRegistrationMode(api) ? api.logger.debug : api.logger.info)(
          "clawlore: smart extraction enabled (LLM model: "
          + llmModel
          + ", timeoutMs: "
          + llmTimeoutMs
          + ", noise bank: ON)",
        );
      } catch (err) {
        api.logger.warn(`clawlore: smart extraction init failed, falling back to regex: ${diagnosticErrorSummary(err)}`);
      }
    }

    // Extraction rate limiter (Feature 7: Adaptive Extraction Throttling)
    // NOTE: This rate limiter is global — shared across all agents in multi-agent setups.
    const extractionRateLimiter = createExtractionRateLimiter({
      maxExtractionsPerHour: config.extractionThrottle?.maxExtractionsPerHour,
    });

    registerClawLoreShadowRuntime({
      api,
      config,
      resolvedDbPath,
      retriever,
      scopeManager,
      pluginEntryUrl: import.meta.url,
    });

    const reflectionRuntimeState = new ReflectionRuntimeState({
      store,
      sessionTtlMs: DEFAULT_REFLECTION_SESSION_TTL_MS,
      maxTrackedSessions: DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
    });

    // Bounded cross-hook cursor. Access and persistence remain composition concerns;
    // this object only aligns ingress messages with the later agent_end snapshot.
    const autoCaptureSessionState = new AutoCaptureSessionState();

    const runtimeMemoryAccessFor = (event: unknown, ctx: any) => {
      const sessionKey = typeof ctx?.sessionKey === "string"
        ? ctx.sessionKey
        : typeof (event as any)?.sessionKey === "string"
          ? (event as any).sessionKey
          : undefined;
      const agentId = resolveHookAgentId(ctx?.agentId, sessionKey);
      return {
        agentId,
        access: resolveRuntimeMemoryAccess({
          scopeManager,
          agentId,
          config: config.principalIsolation,
          runtimeContext: ctx,
          event,
        }),
      };
    };

    const logReg = isCliRegistrationMode(api) ? api.logger.debug : api.logger.info;
    logReg(
      `clawlore@${pluginVersion}: plugin registered (db: ${resolvedDbPath}, model: ${embeddingModel}, vectorBackend: ${config.vectorBackend || "lancedb"}, smartExtraction: ${smartExtractor ? 'ON' : 'OFF'})`
    );
    logReg(`clawlore: diagnostic build tag loaded (${diagnosticBuildTag})`);

    api.on("message_received", (event: any, ctx: any) => {
      const { access } = runtimeMemoryAccessFor(event, ctx);
      if (!access.denied) {
        autoCaptureSessionState.recordIngress({
          channelId: ctx.channelId,
          conversationId: ctx.conversationId,
          content: event.content,
          shouldSkipMessage: shouldSkipReflectionMessage,
        });
      }
      api.logger.debug(
        `clawlore: ingress message_received channel=${diagnosticIdentifier(ctx.channelId)} account=${diagnosticIdentifier(ctx.accountId)} conversation=${diagnosticIdentifier(ctx.conversationId)} from=${diagnosticIdentifier(event.from)} ${diagnosticTextSummary(event.content)}`,
      );
    });

    api.on("before_message_write", (event: any, ctx: any) => {
      const message = event.message as Record<string, unknown> | undefined;
      const role =
        message && typeof message.role === "string" && message.role.trim().length > 0
          ? message.role
          : "unknown";
      if (role !== "user") {
        return;
      }
      api.logger.debug(
        `clawlore: ingress before_message_write agent=${diagnosticIdentifier(ctx.agentId || event.agentId)} session=${diagnosticIdentifier(ctx.sessionKey || event.sessionKey)} role=${role} ${summarizeMessageContent(message?.content)}`,
      );
    });

    // ========================================================================
    // Markdown Mirror
    // ========================================================================

    const mdMirror = createMdMirrorWriter(
      api,
      config.mdMirror,
      resolvedDbPath,
      diagnosticErrorSummary,
    );

    // ========================================================================
    // Register Tools
    // ========================================================================

    const agentOperatorToolsEnabled =
      config.enableManagementTools === true && config.allowAgentOperatorTools === true;

    registerAllMemoryTools(
      api,
      {
        retriever,
        store,
        scopeManager,
        embedder,
        agentId: undefined, // Will be determined at runtime from context
        workspaceDir: getDefaultWorkspaceDir(),
        mdMirror,
        workspaceBoundary: config.workspaceBoundary,
        principalIsolation: config.principalIsolation,
      },
      {
        enableManagementTools: agentOperatorToolsEnabled,
        enableSelfImprovementTools: config.selfImprovement?.enabled === true,
        secretIndexToolsEnabled: config.secretIndexToolsEnabled === true,
      }
    );

    if (agentOperatorToolsEnabled || config.taskExperienceCapture?.enabled === true) {
      registerExperienceTools(
        api,
        {
          retriever,
          store,
          scopeManager,
          embedder,
          agentId: undefined,
          workspaceDir: getDefaultWorkspaceDir(),
          mdMirror,
          workspaceBoundary: config.workspaceBoundary,
          principalIsolation: config.principalIsolation,
          db: () => store.getSqlTruthDb(),
        },
        {
          enableManagementTools: agentOperatorToolsEnabled,
        },
      );
      logReg("clawlore: Experience Kernel tools registered");
      void store.getSqlTruthDb()
        .then((db) => {
          if (db) ensureExperienceSchema(db);
        })
        .catch((err) => {
          api.logger.warn(`clawlore: Experience Kernel schema initialization failed: ${diagnosticErrorSummary(err)}`);
        });
    }

    // Startup compaction is never destructive. Legacy `enabled: true` alone no
    // longer opts a deployment into mutation during Gateway startup.
    if (
      config.memoryCompaction?.enabled === true
      && config.memoryCompaction.startupMode === "dry-run"
    ) {
      api.on("gateway_start", () => {
        const compactionStateFile = join(
          dirname(resolvedDbPath),
          ".compaction-state.json",
        );
        const compactionCfg: CompactionConfig = {
          enabled: true,
          minAgeDays: config.memoryCompaction!.minAgeDays ?? 7,
          similarityThreshold: config.memoryCompaction!.similarityThreshold ?? 0.88,
          minClusterSize: config.memoryCompaction!.minClusterSize ?? 2,
          maxMemoriesToScan: config.memoryCompaction!.maxMemoriesToScan ?? 200,
          dryRun: true,
          cooldownHours: config.memoryCompaction!.cooldownHours ?? 24,
        };

        shouldRunCompaction(compactionStateFile, compactionCfg.cooldownHours)
          .then(async (should) => {
            if (!should) return;
            const result = await runCompaction(store, embedder, compactionCfg, undefined, api.logger);
            if (result.clustersFound > 0) {
              api.logger.info(
                `memory-compactor [startup dry-run]: ${result.clustersFound} candidate clusters; no data changed`,
              );
            }
          })
          .catch((err) => {
            api.logger.warn(`memory-compactor [auto]: failed: ${diagnosticErrorSummary(err)}`);
          });
      });
    }

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    registerAutoRecallHooks({ api, config, retriever, store, scopeManager, resolveRuntimeAccess: runtimeMemoryAccessFor });

    registerAutoCaptureHooks({
      api, config, store, embedder, scopeManager, smartExtractor, extractionRateLimiter,
      sessionState: autoCaptureSessionState, mdMirror, resolveRuntimeAccess: runtimeMemoryAccessFor,
      resolveWorkspaceDir: resolveWorkspaceDirFromContext,
    });

    registerTaskExperienceHooks({
      api, config, store, embedder, scopeManager, llmClient: llmClientForExtraction, mdMirror,
      resolveRuntimeAccess: runtimeMemoryAccessFor, isInternalSession: isInternalReflectionSessionKey,
      logRegistration: logReg,
    });

    registerSelfImprovementHooks({
      api, config, resolveWorkspaceDir: resolveWorkspaceDirFromContext,
      isInternalSession: isInternalReflectionSessionKey, logRegistration: logReg,
    });

    registerReflectionHooks({
      api, config, store, embedder, scopeManager, state: reflectionRuntimeState, mdMirror,
      resolveRuntimeAccess: runtimeMemoryAccessFor, resolveWorkspaceDir: resolveWorkspaceDirFromContext,
      resolveAgentId: resolveHookAgentId, logRegistration: logReg,
    });

    // ========================================================================
    // Auto-Backup (daily JSONL export)
    // ========================================================================

    let startupChecksTimer: ReturnType<typeof setTimeout> | null = null;
    let legacyScanTimer: ReturnType<typeof setTimeout> | null = null;

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService({
      id: CLAWLORE_PLUGIN_ID,
      start: async () => {
        api.logger.info(`clawlore: service start (db=${diagnosticIdentifier(resolvedDbPath)})`);

        // IMPORTANT: Do not block gateway startup on external network calls.
        // If embedding/retrieval tests hang (bad network / slow provider), the gateway
        // may never bind its HTTP port, causing restart timeouts.

        const withTimeout = async <T>(
          p: Promise<T>,
          ms: number,
          label: string,
        ): Promise<T> => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${label} timed out after ${ms}ms`)),
              ms,
            );
          });
          try {
            return await Promise.race([p, timeoutPromise]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        };

        const runStartupChecks = async () => {
          try {
            // Test components (bounded time)
            const embedTest = await withTimeout(
              embedder.test(),
              30_000,
              "embedder.test()",
            );
            const retrievalTest = await withTimeout(
              retriever.test(),
              30_000,
              "retriever.test()",
            );

            api.logger.info(
              `clawlore: initialized successfully ` +
              `(embedding: ${embedTest.success ? "OK" : "FAIL"}, ` +
              `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
              `mode: ${retrievalTest.mode}, ` +
              `FTS: ${retrievalTest.hasFtsSupport ? "enabled" : "disabled"})`,
            );

            if (!embedTest.success) {
              api.logger.warn(
                `clawlore: embedding test failed: ${embedTest.error}`,
              );
            }
            if (!retrievalTest.success) {
              api.logger.warn(
                `clawlore: retrieval test failed: ${retrievalTest.error}`,
              );
            }
          } catch (error) {
            api.logger.warn(
              `clawlore: startup checks failed: ${diagnosticErrorSummary(error)}`,
            );
          }
        };

        // Fire-and-forget: allow gateway to start serving immediately.
        startupChecksTimer = setTimeout(() => void runStartupChecks(), 45_000);

        // Check for legacy memories that could be upgraded
        legacyScanTimer = setTimeout(async () => {
          try {
            const upgrader = createMemoryUpgrader(store, null);
            const counts = await upgrader.countLegacy();
            if (counts.legacy > 0) {
              api.logger.info(
                `clawlore: found ${counts.legacy} legacy memories (of ${counts.total} total) that can be upgraded to the new smart memory format. ` +
                `Run 'openclaw clawlore upgrade' to convert them.`
              );
            }
          } catch {
            // Non-critical: silently ignore
          }
        }, 5_000);

        if (config.autoBackup === true) {
          api.logger.warn(
            "clawlore: legacy plaintext autoBackup is disabled; use the ClawLore snapshot/export operator flow",
          );
        } else {
          api.logger.info("clawlore: legacy plaintext JSONL backups disabled");
        }
      },
      stop: async () => {
        if (startupChecksTimer) {
          clearTimeout(startupChecksTimer);
          startupChecksTimer = null;
        }
        if (legacyScanTimer) {
          clearTimeout(legacyScanTimer);
          legacyScanTimer = null;
        }
        api.logger.info("clawlore: stopped");
      },
    });
  },
};

export default clawLorePlugin;
