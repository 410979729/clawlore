import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  diagnosticErrorSummary,
  diagnosticHash,
  diagnosticIdentifier,
} from "./diagnostic-redaction.js";
import type { createEmbedder } from "./embedder.js";
import {
  createTaskEpisode,
  ensureExperienceSchema,
  recordTaskExperienceCaptureEvent,
} from "./experience-store.js";
import type { createLlmClient } from "./llm-client.js";
import type { MarkdownMirrorWriter } from "./markdown-mirror.js";
import type { PluginConfig } from "./plugin-config.js";
import type { resolveRuntimeMemoryAccess } from "./runtime-memory-boundary.js";
import { isSystemBypassId, type createScopeManager } from "./scopes.js";
import type { MemoryStore } from "./store.js";
import {
  agentEndEventAllowsTaskExperience,
  buildTaskExperienceEpisodeDraft,
  captureTaskExperience,
  extractTaskExperienceTranscript,
} from "./task-experience.js";

type RuntimeAccessResolver = (
  event: unknown,
  context: any,
) => { agentId: string; access: ReturnType<typeof resolveRuntimeMemoryAccess> };

/** Registers successful, tool-backed task distillation as a background hook. */
export function registerTaskExperienceHooks(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  scopeManager: ReturnType<typeof createScopeManager>;
  llmClient: ReturnType<typeof createLlmClient> | null;
  mdMirror: MarkdownMirrorWriter | null;
  resolveRuntimeAccess: RuntimeAccessResolver;
  isInternalSession(sessionKey: unknown): boolean;
  logRegistration(message: string): void;
}): void {
  const { api, config, store, embedder, scopeManager } = params;
  if (config.taskExperienceCapture?.enabled !== true) return;
  type CaptureHook = { (event: any, ctx: any): void; __lastRun?: Promise<void> };

  const hook: CaptureHook = (event, ctx) => {
    if (!agentEndEventAllowsTaskExperience(event) || !Array.isArray(event.messages) || event.messages.length === 0) return;
    const sessionKey = typeof ctx?.sessionKey === "string"
      ? ctx.sessionKey
      : typeof event.sessionKey === "string"
        ? event.sessionKey
        : "";
    if (params.isInternalSession(sessionKey)) return;

    const backgroundRun = (async () => {
      try {
        const { agentId, access } = params.resolveRuntimeAccess(event, ctx);
        if (access.denied) return;
        if (!params.llmClient) {
          api.logger.debug("task-experience: skipped because the configured review LLM is unavailable");
          return;
        }
        const defaultScope = access.defaultScope ?? (isSystemBypassId(agentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(agentId));
        const captureConfig = config.taskExperienceCapture!;
        const transcript = extractTaskExperienceTranscript(event.messages, captureConfig.maxInputChars);
        const result = await captureTaskExperience({
          messages: event.messages,
          sessionKey,
          sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined,
          agentId,
          scope: defaultScope,
          config: captureConfig,
          llmClient: params.llmClient,
          embedder,
          store,
          mdMirror: params.mdMirror,
          logger: api.logger,
          agentEndEvent: event,
        });

        const taskSessionId = sessionKey || (typeof ctx?.sessionId === "string" ? ctx.sessionId : "unknown");
        let episodeId = "";
        try {
          const db = await store.getSqlTruthDb();
          if (db) {
            ensureExperienceSchema(db);
            const draft = buildTaskExperienceEpisodeDraft({ transcript, result, agentId });
            if (draft) {
              const episode = createTaskEpisode(db, {
                scope_id: defaultScope,
                session_id: taskSessionId,
                task_class: draft.task_class,
                task_goal: draft.task_goal,
                user_intent: draft.user_intent,
                status: draft.status,
                outcome: draft.outcome,
                tool_names: draft.tool_names,
                evidence: draft.evidence,
                verification: draft.verification,
                metadata: draft.metadata,
              });
              episodeId = episode.id;
              api.logger.info(`task-experience: recorded episode hash=${diagnosticHash(episode.id)} action=${result.action} outcome=${episode.outcome}`);
            }
            recordTaskExperienceCaptureEvent(db, {
              scope_id: defaultScope,
              session_id: taskSessionId,
              agent_id: agentId,
              action: result.action,
              reason: result.action === "skipped" ? result.reason : "",
              task_class: result.action === "created" || result.action === "duplicate" ? result.taskType : "",
              memory_id: result.action === "created" ? result.id : "",
              existing_memory_id: result.action === "duplicate" ? result.existingId : "",
              similarity: result.action === "duplicate" ? result.similarity : 0,
              metadata: {
                source: "task-experience",
                auto_recorded: true,
                episode_id: episodeId,
                mirror_status: result.action === "created" ? result.mirrorStatus : "not_applicable",
              },
            });
          } else {
            api.logger.debug("task-experience: skipped episode/capture ledger because SQL truth DB is unavailable");
          }
        } catch (error) {
          api.logger.warn(`task-experience: episode/capture ledger write failed: ${diagnosticErrorSummary(error)}`);
        }

        if (result.action === "created") {
          api.logger.info(`task-experience: stored reusable task experience hash=${diagnosticHash(result.id)} (${result.taskType}) agent=${diagnosticIdentifier(agentId)}`);
        } else if (result.action === "duplicate") {
          api.logger.debug(`task-experience: duplicate skipped (${result.taskType}) existingHash=${diagnosticHash(result.existingId)} similarity=${result.similarity.toFixed(3)}`);
        } else {
          api.logger.info(`task-experience: skipped (${result.reason})`);
        }
      } catch (error) {
        api.logger.warn(`task-experience: capture failed: ${diagnosticErrorSummary(error)}`);
      }
    })();
    hook.__lastRun = backgroundRun;
    void backgroundRun;
  };

  api.on("agent_end", hook);
  params.logRegistration("task-experience: successful task capsule capture enabled");
}
