import { createHash } from "node:crypto";
import type { ReleaseReadinessReceiptV1 } from "../../v2/domain/release.js";
import type { ContextCandidateV1 } from "../../application/context-composer.js";
import {
  negotiateContextEngineV2,
  type ContextEngineActivationV2,
  type ContextEngineHostCapabilitiesV2,
  type ContextEngineNegotiationV2,
} from "./context-engine-skeleton.js";
import type {
  CompatibilityRetrievalRequestV1,
} from "./compatibility-context-adapter.js";
import {
  JsonlRuntimeShadowTraceSink,
  runDefaultOffRuntimeShadow,
  type RuntimeShadowReceiptV1,
  type RuntimeShadowTraceSink,
} from "./runtime-shadow.js";

export type ClawLoreRuntimeModeV1 = "disabled" | "shadow";

export interface ClawLoreRuntimeConfigV1 {
  mode: ClawLoreRuntimeModeV1;
  contextEngine: ContextEngineActivationV2;
  tokenBudget: number;
  maxLatencyMs: number;
  traceFile?: string;
  maxTraceBytes: number;
  maxQueryChars: number;
  candidateLimit: number;
  maxConcurrent: number;
}

export type MessageReceivedHandlerV1 = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<void>;

export interface OpenClawRuntimeHostV1 {
  capabilities?: Partial<ContextEngineHostCapabilitiesV2>;
  on(
    event: "message_received",
    handler: MessageReceivedHandlerV1,
    options?: { priority?: number },
  ): void;
}

export interface RuntimeCompositionReceiptV1 {
  schemaVersion: 1;
  status: "disabled" | "blocked" | "registered";
  requestedMode: ClawLoreRuntimeModeV1;
  registeredHooks: Array<"message_received">;
  toolRegistrations: 0;
  writeEnabled: false;
  promptMutationEnabled: false;
  contextEngineRegistered: false;
  contextEngine: ContextEngineNegotiationV2;
  blockingReasons: string[];
}

export interface RuntimeCompositionDependenciesV1 {
  tenantId: string;
  agentId: string;
  workspaceId?: string;
  retrieveCandidates(request: CompatibilityRetrievalRequestV1): Promise<ContextCandidateV1[]>;
  retrieveComparisonCandidates?(request: CompatibilityRetrievalRequestV1): Promise<ContextCandidateV1[]>;
  traceSink?: RuntimeShadowTraceSink;
  now?: () => Date;
  onObserverError?(code:
    | "shadow_observer_failed"
    | "shadow_observer_timeout"
    | "shadow_observer_deduplicated"
    | "shadow_observer_saturated"
  ): void;
  onObserverMetrics?(metrics: {
    active: number;
    late: number;
    timeouts: number;
    saturated: number;
  }): void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function normalizeClawLoreRuntimeConfigV1(value: unknown): ClawLoreRuntimeConfigV1 {
  const raw = record(value);
  const mode: ClawLoreRuntimeModeV1 = raw.mode === "shadow" ? "shadow" : "disabled";
  const contextEngine: ContextEngineActivationV2 = raw.contextEngine === "native-opt-in"
    ? "native-opt-in"
    : "compatibility";
  return {
    mode,
    contextEngine,
    tokenBudget: boundedInteger(raw.tokenBudget, 512, 32, 32_768),
    maxLatencyMs: boundedInteger(raw.maxLatencyMs, 750, 25, 5_000),
    traceFile: typeof raw.traceFile === "string" && raw.traceFile.trim()
      ? raw.traceFile.trim()
      : undefined,
    maxTraceBytes: boundedInteger(raw.maxTraceBytes, 5_000_000, 16_384, 100_000_000),
    maxQueryChars: boundedInteger(raw.maxQueryChars, 4_000, 256, 12_000),
    candidateLimit: boundedInteger(raw.candidateLimit, 6, 1, 20),
    maxConcurrent: boundedInteger(raw.maxConcurrent, 2, 1, 16),
  };
}

function shadowQueryText(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
  maxChars: number,
): string {
  const candidates = [
    event.bodyForAgent,
    event.body,
    event.content,
    event.userPrompt,
    event.prompt,
    event.text,
    event.content,
    context.userPrompt,
    context.prompt,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function shadowChatType(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): "direct" | "group" | "channel" | undefined {
  if (event.isGroup === true) return "group";
  if (event.isGroup === false) return "direct";

  const sessionKey = [context.sessionKey, event.sessionKey]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof sessionKey === "string") {
    const match = sessionKey.match(/:(direct|group|channel):/i);
    if (match?.[1]) return match[1].toLowerCase() as "direct" | "group" | "channel";
  }

  const metadata = record(event.metadata);
  if (metadata.guildId || metadata.groupId || metadata.channelName) return "group";
  return undefined;
}

function shadowVisibility(
  chatType: ReturnType<typeof shadowChatType>,
): "private" | "conversation" {
  // Unknown ingress types fail toward conversation scope so a group message
  // can never be treated as a private-memory request.
  return chatType === "direct" ? "private" : "conversation";
}

async function observeWithoutBlockingReply(input: {
  operation: Promise<unknown>;
  controller: AbortController;
  maxLatencyMs: number;
  onError?: RuntimeCompositionDependenciesV1["onObserverError"];
}): Promise<"completed" | "failed" | "aborted" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = input.operation
    .then(() => "completed" as const)
    .catch(() => {
      if (!input.controller.signal.aborted) input.onError?.("shadow_observer_failed");
      return input.controller.signal.aborted ? "aborted" as const : "failed" as const;
    });
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      input.controller.abort("shadow_observer_timeout");
      resolve("timeout");
    }, input.maxLatencyMs);
  });
  const outcome = await Promise.race([operation, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") input.onError?.("shadow_observer_timeout");
  return outcome;
}

function observerKey(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  const material = [
    context.sessionKey,
    context.sessionId,
    context.conversationId,
    event.senderId,
    context.senderId,
  ].map((value) => String(value ?? "")).join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

function activationBlocks(input: {
  config: ClawLoreRuntimeConfigV1;
  readiness?: ReleaseReadinessReceiptV1;
}): string[] {
  if (input.config.mode === "disabled") return [];
  const blocks: string[] = [];
  const readiness = input.readiness;
  if (!readiness) {
    blocks.push("release_readiness_missing");
  } else {
    if (readiness.status !== "ready" || !readiness.rollout.ready) blocks.push("release_readiness_blocked");
    if (readiness.rollout.requestedMode !== "shadow") blocks.push("readiness_mode_mismatch");
    if (!readiness.rollout.readOnly) blocks.push("readiness_not_read_only");
  }
  if (input.config.contextEngine !== "compatibility") blocks.push("native_context_engine_not_enabled_in_this_slice");
  return [...new Set(blocks)].sort();
}

function numericBudget(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
  fallback: number,
): number {
  const candidates = [
    context.availableTokens,
    context.tokenBudget,
    record(context.budget).availableTokens,
    event.availableTokens,
    event.tokenBudget,
    record(event.budget).availableTokens,
  ];
  const value = candidates.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return boundedInteger(value, fallback, 32, 32_768);
}

function opaqueTraceId(
  sequence: number,
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  const material = [
    event.runId,
    event.sessionKey,
    context.runId,
    context.sessionId,
    context.sessionKey,
    event.id,
    event.messageId,
    sequence,
  ].map((value) => String(value ?? "")).join("\u0000");
  return `clawlore-shadow-${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

export function composeClawLoreRuntimeV1(input: {
  config: ClawLoreRuntimeConfigV1;
  host: OpenClawRuntimeHostV1;
  dependencies: RuntimeCompositionDependenciesV1;
  readiness?: ReleaseReadinessReceiptV1;
}): RuntimeCompositionReceiptV1 {
  const contextEngine = negotiateContextEngineV2({
    requested: input.config.contextEngine,
    host: input.host.capabilities ?? {},
  });
  const blockingReasons = activationBlocks(input);
  const base = {
    schemaVersion: 1 as const,
    requestedMode: input.config.mode,
    toolRegistrations: 0 as const,
    writeEnabled: false as const,
    promptMutationEnabled: false as const,
    contextEngineRegistered: false as const,
    contextEngine,
    blockingReasons,
  };
  if (input.config.mode === "disabled") {
    return { ...base, status: "disabled", registeredHooks: [] };
  }
  if (blockingReasons.length > 0) {
    return { ...base, status: "blocked", registeredHooks: [] };
  }

  const sink = input.dependencies.traceSink
    ?? (input.config.traceFile
      ? new JsonlRuntimeShadowTraceSink(input.config.traceFile, input.config.maxTraceBytes)
      : undefined);
  let sequence = 0;
  const activeObservers = new Set<string>();
  let lateObservers = 0;
  let observerTimeouts = 0;
  let observerSaturations = 0;
  const emitObserverMetrics = () => input.dependencies.onObserverMetrics?.({
    active: activeObservers.size,
    late: lateObservers,
    timeouts: observerTimeouts,
    saturated: observerSaturations,
  });
  input.host.on("message_received", async (event, context) => {
    sequence += 1;
    const metadata = record(event.metadata);
    const chatType = shadowChatType(event, context);
    const key = observerKey(event, context);
    if (activeObservers.has(key)) {
      input.dependencies.onObserverError?.("shadow_observer_deduplicated");
      return;
    }
    if (activeObservers.size >= input.config.maxConcurrent) {
      observerSaturations += 1;
      input.dependencies.onObserverError?.("shadow_observer_saturated");
      emitObserverMetrics();
      return;
    }
    const controller = new AbortController();
    activeObservers.add(key);
    emitObserverMetrics();
    const operation = runDefaultOffRuntimeShadow({
      config: { enabled: true },
      sink,
      now: input.dependencies.now,
      input: {
        traceId: opaqueTraceId(sequence, event, context),
        ingressKind: chatType ?? "unknown",
        availableTokens: numericBudget(event, context, input.config.tokenBudget),
        queryText: shadowQueryText(event, context, input.config.maxQueryChars),
        signal: controller.signal,
        identity: {
          tenantId: input.dependencies.tenantId,
          agentId: typeof context.agentId === "string" && context.agentId.trim()
            ? context.agentId.trim()
            : input.dependencies.agentId,
          workspaceId: input.dependencies.workspaceId,
          requestedVisibility: shadowVisibility(chatType),
          runtimeContext: context,
          event,
          staticContext: {
            platform: context.channelId ?? metadata.originatingChannel
              ?? metadata.provider ?? metadata.surface,
            accountId: context.accountId,
            senderId: event.senderId ?? context.senderId ?? metadata.senderId,
            conversationId: context.conversationId ?? metadata.originatingTo,
            threadId: event.threadId ?? metadata.threadId,
            chatType: chatType ?? "unknown",
          },
        },
        retrieveCandidates: input.dependencies.retrieveCandidates,
        ...(input.dependencies.retrieveComparisonCandidates
          ? { retrieveComparisonCandidates: input.dependencies.retrieveComparisonCandidates }
          : {}),
      },
    });
    const outcome = await observeWithoutBlockingReply({
      operation,
      controller,
      maxLatencyMs: input.config.maxLatencyMs,
      onError: input.dependencies.onObserverError,
    });
    // Release the concurrency slot when the bounded observer window ends,
    // even when a non-cooperative provider ignores AbortSignal forever.
    activeObservers.delete(key);
    if (outcome === "timeout") {
      observerTimeouts += 1;
      lateObservers += 1;
      void operation.then(
        () => { lateObservers = Math.max(0, lateObservers - 1); emitObserverMetrics(); },
        () => { lateObservers = Math.max(0, lateObservers - 1); emitObserverMetrics(); },
      );
    }
    emitObserverMetrics();
  }, { priority: -100 });

  return { ...base, status: "registered", registeredHooks: ["message_received"] };
}

export class InMemoryRuntimeShadowSinkV1 implements RuntimeShadowTraceSink {
  readonly receipts: RuntimeShadowReceiptV1[] = [];

  async append(receipt: RuntimeShadowReceiptV1): Promise<void> {
    this.receipts.push(structuredClone(receipt));
  }
}
