import { createHash } from "node:crypto";
import type { ReleaseReadinessReceiptV1 } from "../../domain/release.js";
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
}

export interface RuntimeRolloutApprovalV1 {
  schemaVersion: 1;
  rolloutId: string;
  mode: "shadow";
  decision: "approved";
  actor: string;
  approvedAt: string;
}

export type BeforePromptBuildHandlerV1 = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<undefined>;

export interface OpenClawRuntimeHostV1 {
  capabilities?: Partial<ContextEngineHostCapabilitiesV2>;
  on(
    event: "before_prompt_build",
    handler: BeforePromptBuildHandlerV1,
    options?: { priority?: number },
  ): void;
}

export interface RuntimeCompositionReceiptV1 {
  schemaVersion: 1;
  status: "disabled" | "blocked" | "registered";
  requestedMode: ClawLoreRuntimeModeV1;
  registeredHooks: Array<"before_prompt_build">;
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
  traceSink?: RuntimeShadowTraceSink;
  now?: () => Date;
  onObserverError?(code: "shadow_observer_failed" | "shadow_observer_timeout"): void;
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
  };
}

function shadowQueryText(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
  maxChars: number,
): string {
  const candidates = [
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

function validApproval(
  approval: RuntimeRolloutApprovalV1 | undefined,
  readiness: ReleaseReadinessReceiptV1 | undefined,
): boolean {
  if (!approval || !readiness) return false;
  return approval.schemaVersion === 1
    && approval.decision === "approved"
    && approval.mode === "shadow"
    && typeof approval.actor === "string"
    && Boolean(approval.actor.trim())
    && typeof approval.rolloutId === "string"
    && approval.rolloutId === readiness.rollout.rolloutId
    && typeof approval.approvedAt === "string"
    && Number.isFinite(Date.parse(approval.approvedAt));
}

async function observeWithoutBlockingReply(input: {
  operation: Promise<unknown>;
  maxLatencyMs: number;
  onError?: RuntimeCompositionDependenciesV1["onObserverError"];
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = input.operation
    .then(() => "completed" as const)
    .catch(() => {
      input.onError?.("shadow_observer_failed");
      return "failed" as const;
    });
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.maxLatencyMs);
  });
  const outcome = await Promise.race([operation, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") input.onError?.("shadow_observer_timeout");
}

function activationBlocks(input: {
  config: ClawLoreRuntimeConfigV1;
  readiness?: ReleaseReadinessReceiptV1;
  approval?: RuntimeRolloutApprovalV1;
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
    if (!readiness.rollout.requiresOperatorApproval) blocks.push("approval_contract_missing");
  }
  if (!validApproval(input.approval, readiness)) blocks.push("operator_approval_missing_or_invalid");
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
  approval?: RuntimeRolloutApprovalV1;
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
  input.host.on("before_prompt_build", async (event, context) => {
    sequence += 1;
    await observeWithoutBlockingReply({
      maxLatencyMs: input.config.maxLatencyMs,
      onError: input.dependencies.onObserverError,
      operation: runDefaultOffRuntimeShadow({
        config: { enabled: true },
        sink,
        now: input.dependencies.now,
        input: {
          traceId: opaqueTraceId(sequence, event, context),
          availableTokens: numericBudget(event, context, input.config.tokenBudget),
          queryText: shadowQueryText(event, context, input.config.maxQueryChars),
          identity: {
            tenantId: input.dependencies.tenantId,
            agentId: typeof context.agentId === "string" && context.agentId.trim()
              ? context.agentId.trim()
              : input.dependencies.agentId,
            workspaceId: input.dependencies.workspaceId,
            runtimeContext: context,
            event,
          },
          retrieveCandidates: input.dependencies.retrieveCandidates,
        },
      }),
    });
    return undefined;
  }, { priority: -100 });

  return { ...base, status: "registered", registeredHooks: ["before_prompt_build"] };
}

export class InMemoryRuntimeShadowSinkV1 implements RuntimeShadowTraceSink {
  readonly receipts: RuntimeShadowReceiptV1[] = [];

  async append(receipt: RuntimeShadowReceiptV1): Promise<void> {
    this.receipts.push(structuredClone(receipt));
  }
}
