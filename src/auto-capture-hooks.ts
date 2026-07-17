import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { regexFallbackGovernance } from "./auto-capture-governance.js";
import { detectCategory, shouldCapture } from "./auto-capture-policy.js";
import type { AutoCaptureSessionState } from "./auto-capture-session-state.js";
import {
  diagnosticErrorSummary,
  diagnosticHash,
  diagnosticIdentifier,
  diagnosticTextSummary,
} from "./diagnostic-redaction.js";
import type { createEmbedder } from "./embedder.js";
import type { MarkdownMirrorWriter } from "./markdown-mirror.js";
import { isNoise } from "./noise-filter.js";
import type { PluginConfig } from "./plugin-config.js";
import { buildRuntimeScopeMetadata } from "./runtime-scope-metadata.js";
import {
  runtimeBoundaryMetadata,
  type resolveRuntimeMemoryAccess,
} from "./runtime-memory-boundary.js";
import type { createScopeManager } from "./scopes.js";
import { isSystemBypassId } from "./scopes.js";
import { compressTexts, estimateConversationValue } from "./session-compressor.js";
import type { createExtractionRateLimiter, SmartExtractor } from "./smart-extractor.js";
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import type { MemoryStore } from "./store.js";
import { shouldSkipReflectionMessage } from "./reflection-transcript.js";
import { isUserMdExclusiveMemory } from "./workspace-boundary.js";

type RuntimeAccessResolver = (
  event: unknown,
  context: any,
) => { agentId: string; access: ReturnType<typeof resolveRuntimeMemoryAccess> };

function summarizeAgentEndMessages(messages: unknown[]): string {
  const roleCounts = new Map<string, number>();
  let textBlocks = 0;
  let stringContents = 0;
  let arrayContents = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" && record.role.trim() ? record.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    if (typeof record.content === "string") stringContents += 1;
    else if (Array.isArray(record.content)) {
      arrayContents += 1;
      for (const block of record.content) {
        if (
          block && typeof block === "object"
          && (block as Record<string, unknown>).type === "text"
          && typeof (block as Record<string, unknown>).text === "string"
        ) textBlocks += 1;
      }
    }
  }
  const roles = [...roleCounts].map(([role, count]) => `${role}:${count}`).join(", ") || "none";
  return `messages=${messages.length}, roles=[${roles}], stringContents=${stringContents}, arrayContents=${arrayContents}, textBlocks=${textBlocks}`;
}

function summarizeCaptureDecision(text: string): string {
  const trimmed = text.trim();
  return `${diagnosticTextSummary(trimmed)}, trigger=${shouldCapture(trimmed) ? "Y" : "N"}, noise=${isNoise(trimmed) ? "Y" : "N"}`;
}

/** Registers background auto-capture without holding the host session lock. */
export function registerAutoCaptureHooks(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  scopeManager: ReturnType<typeof createScopeManager>;
  smartExtractor: SmartExtractor | null;
  extractionRateLimiter: ReturnType<typeof createExtractionRateLimiter>;
  sessionState: AutoCaptureSessionState;
  mdMirror: MarkdownMirrorWriter | null;
  resolveRuntimeAccess: RuntimeAccessResolver;
  resolveWorkspaceDir(context: Record<string, unknown> | undefined): string;
}): void {
  const { api, config, store, embedder, scopeManager } = params;
  if (config.autoCapture !== true) return;
  type CaptureHook = { (event: any, ctx: any): void; __lastRun?: Promise<void> };

  const hook: CaptureHook = (event, ctx) => {
    if (event.success === false || !event.messages || event.messages.length === 0) return;
    // Fire-and-forget is intentional: awaiting this hook can drop later channel deliveries while the session lock is held.
    const backgroundRun = (async () => {
      try {
        const { agentId, access } = params.resolveRuntimeAccess(event, ctx);
        if (access.denied) return;
        if (params.extractionRateLimiter.isRateLimited()) {
          api.logger.debug(
            `clawlore: auto-capture skipped (rate limited: ${params.extractionRateLimiter.getRecentCount()} extractions in last hour)`,
          );
          return;
        }

        const accessibleScopes = access.scopeFilter;
        const defaultScope = access.defaultScope ?? (isSystemBypassId(agentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(agentId));
        const sessionKey = ctx?.sessionKey || event.sessionKey || "unknown";
        const runtimeScopeMetadata = buildRuntimeScopeMetadata({
          agentId,
          runtimeContext: ctx,
          event,
          scope: defaultScope,
          scopeFilter: accessibleScopes,
          workspaceDir: params.resolveWorkspaceDir(ctx),
          sourceSession: sessionKey,
        });
        Object.assign(runtimeScopeMetadata, runtimeBoundaryMetadata(access.boundary));
        api.logger.debug(
          `clawlore: auto-capture agent_end payload agent=${diagnosticIdentifier(agentId)} session=${diagnosticIdentifier(sessionKey)} (captureAssistant=${config.captureAssistant === true}, ${summarizeAgentEndMessages(event.messages)})`,
        );

        const selection = params.sessionState.consumeAgentEnd({
          sessionKey,
          messages: event.messages,
          captureAssistant: config.captureAssistant === true,
          shouldSkipMessage: shouldSkipReflectionMessage,
        });
        let { texts } = selection;
        const minMessages = config.extractMinMessages ?? 4;
        if (selection.skippedTextCount > 0) {
          api.logger.debug(`clawlore: auto-capture skipped ${selection.skippedTextCount} injected/system text block(s) for agent=${diagnosticIdentifier(agentId)}`);
        }
        if (selection.pendingIngressCount > 0) {
          api.logger.debug(`clawlore: auto-capture using ${selection.pendingIngressCount} pending ingress text(s) for agent=${diagnosticIdentifier(agentId)}`);
        }
        if (texts.length !== selection.eligibleTexts.length) {
          api.logger.debug(`clawlore: auto-capture narrowed ${selection.eligibleTexts.length} eligible history text(s) to ${texts.length} new text(s) for agent=${diagnosticIdentifier(agentId)}`);
        }
        api.logger.debug(`clawlore: auto-capture collected ${texts.length} text(s) for agent=${diagnosticIdentifier(agentId)} (minMessages=${minMessages}, smartExtraction=${params.smartExtractor ? "on" : "off"})`);
        if (texts.length === 0) {
          api.logger.debug(`clawlore: auto-capture found no eligible texts after filtering for agent=${diagnosticIdentifier(agentId)}`);
          return;
        }
        api.logger.debug(
          `clawlore: auto-capture text diagnostics for agent=${diagnosticIdentifier(agentId)}: ${texts.map((text, index) => `#${index + 1}(${summarizeCaptureDecision(text)})`).join(" | ")}`,
        );

        if (config.extractionThrottle?.skipLowValue === true) {
          const value = estimateConversationValue(texts);
          if (value < 0.2) {
            api.logger.debug(`clawlore: auto-capture skipped for agent=${diagnosticIdentifier(agentId)} (low conversation value: ${value.toFixed(2)})`);
            return;
          }
        }
        if (config.sessionCompression?.enabled === true) {
          const compressed = compressTexts(texts, config.extractMaxChars ?? 8000, {
            minScoreToKeep: config.sessionCompression.minScoreToKeep,
          });
          if (compressed.dropped > 0) {
            api.logger.debug(`clawlore: session compression for agent=${diagnosticIdentifier(agentId)}: dropped ${compressed.dropped}/${texts.length} texts (${compressed.totalChars} chars kept)`);
            texts = compressed.texts;
          }
        }

        let degradedReason: string | undefined;
        if (params.smartExtractor) {
          const cleanTexts = await params.smartExtractor.filterNoiseByEmbedding(texts);
          if (cleanTexts.length === 0) {
            api.logger.debug(`clawlore: all texts filtered as embedding noise for agent=${diagnosticIdentifier(agentId)}`);
            return;
          }
          if (cleanTexts.length >= minMessages) {
            api.logger.debug(`clawlore: auto-capture running smart extraction for agent=${diagnosticIdentifier(agentId)} (${cleanTexts.length} clean texts >= ${minMessages})`);
            try {
              const stats = await params.smartExtractor.extractAndPersist(
                cleanTexts.join("\n"),
                sessionKey,
                { scope: defaultScope, scopeFilter: accessibleScopes, runtimeMetadata: runtimeScopeMetadata },
              );
              if (stats.created > 0 || stats.merged > 0) {
                params.extractionRateLimiter.recordExtraction();
                api.logger.info(`clawlore: smart-extracted ${stats.created} created, ${stats.merged} merged, ${stats.skipped} skipped for agent=${diagnosticIdentifier(agentId)}`);
                return;
              }
              if ((stats.boundarySkipped ?? 0) > 0) {
                api.logger.info(`clawlore: smart extraction skipped ${stats.boundarySkipped} USER.md-exclusive candidate(s) for agent=${diagnosticIdentifier(agentId)}; continuing to regex fallback for non-boundary texts`);
              }
              degradedReason = stats.degraded
                ? stats.degradedReason || "smart_extraction_degraded"
                : "smart_extraction_no_persisted_memories";
              api.logger.info(`clawlore: smart extraction produced no persisted memories for agent=${diagnosticIdentifier(agentId)} (created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}); falling back to regex capture degradedReasonHash=${diagnosticHash(degradedReason)}`);
            } catch (error) {
              degradedReason = `smart_extraction_error:${diagnosticHash(error instanceof Error ? error.message : String(error))}`;
              api.logger.warn(`clawlore: smart extraction failed for agent=${diagnosticIdentifier(agentId)}; falling back to degraded regex capture: ${diagnosticErrorSummary(error)}`);
            }
          } else {
            api.logger.debug(`clawlore: auto-capture skipped smart extraction for agent=${diagnosticIdentifier(agentId)} (${cleanTexts.length} < ${minMessages})`);
          }
        }

        api.logger.debug(`clawlore: auto-capture running regex fallback for agent=${diagnosticIdentifier(agentId)}`);
        const toCapture = texts.filter((text) => text && shouldCapture(text) && !isNoise(text));
        if (toCapture.length === 0) {
          api.logger.debug(`clawlore: regex fallback diagnostics for agent=${diagnosticIdentifier(agentId)}: ${texts.map((text, index) => `#${index + 1}(${summarizeCaptureDecision(text)})`).join(" | ")}`);
          api.logger.info(`clawlore: regex fallback found 0 capturable texts for agent=${diagnosticIdentifier(agentId)}`);
          return;
        }
        api.logger.info(`clawlore: regex fallback found ${toCapture.length} capturable text(s) for agent=${diagnosticIdentifier(agentId)}`);

        let stored = 0;
        for (const text of toCapture.slice(0, 2)) {
          if (isUserMdExclusiveMemory({ text }, config.workspaceBoundary)) {
            api.logger.info(`clawlore: skipped USER.md-exclusive auto-capture text for agent=${diagnosticIdentifier(agentId)}`);
            continue;
          }
          const category = detectCategory(text);
          const vector = await embedder.embedPassage(text);
          const governance = regexFallbackGovernance(degradedReason);
          let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
          try {
            existing = await store.vectorSearch(vector, 1, 0.1, [defaultScope]);
          } catch (error) {
            // Dedup is advisory; persistence remains available when the companion lookup fails.
            api.logger.warn(`clawlore: auto-capture duplicate pre-check failed, continue store: ${diagnosticErrorSummary(error)}`);
          }
          if (existing.length > 0 && existing[0].score > 0.90) continue;
          const importance = degradedReason ? 0.45 : 0.7;
          await store.store({
            text,
            vector,
            importance,
            category,
            scope: defaultScope,
            metadata: stringifySmartMetadata(buildSmartMetadata(
              { text, category, importance },
              {
                ...runtimeScopeMetadata,
                l0_abstract: text,
                l1_overview: `- ${text}`,
                l2_content: text,
                source_session: sessionKey,
                source: "auto-capture",
                state: governance.state,
                memory_layer: "working",
                confidence: governance.confidence,
                trust: governance.trust,
                extraction_degraded: governance.extraction_degraded,
                degraded_reason: governance.degraded_reason,
                injected_count: 0,
                bad_recall_count: 0,
                suppressed_until_turn: 0,
              },
            )),
          });
          stored += 1;
          if (params.mdMirror) {
            await params.mdMirror(
              { text, category, scope: defaultScope, timestamp: Date.now() },
              { source: "auto-capture", agentId },
            );
          }
        }
        if (stored > 0) api.logger.info(`clawlore: auto-captured ${stored} memories for agent=${diagnosticIdentifier(agentId)} in scope=${diagnosticIdentifier(defaultScope)}`);
      } catch (error) {
        api.logger.warn(`clawlore: capture failed: ${diagnosticErrorSummary(error)}`);
      }
    })();
    hook.__lastRun = backgroundRun;
    void backgroundRun;
  };
  api.on("agent_end", hook);
}
