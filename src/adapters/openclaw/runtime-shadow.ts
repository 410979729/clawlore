import { createHash } from "node:crypto";
import { lstat, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  appendPrivateFile,
  enforcePrivatePath,
  ensurePrivateDirectory,
} from "../../file-privacy.js";
import {
  runCompatibilityContextShadow,
  type CompatibilityContextShadowInput,
  type CompatibilityContextShadowResult,
} from "./compatibility-context-adapter.js";

export interface RuntimeShadowConfigV1 {
  enabled: boolean;
  traceFile?: string;
  maxTraceBytes?: number;
}

export interface RuntimeShadowReceiptV1 {
  schemaVersion: 1;
  traceId: string;
  status: "disabled" | "completed" | "skipped" | "failed";
  principalHash?: string;
  ingressKind?: "direct" | "group" | "channel" | "unknown";
  visibility?: "private" | "conversation" | "project" | "team" | "global";
  retrievalInvoked: boolean;
  candidateCount: number;
  selectedCount: number;
  usedTokens: number;
  stages: CompatibilityContextShadowResult["trace"];
  rejectionReasons: string[];
  comparison?: CompatibilityContextShadowResult["comparison"];
  errorCode?: string;
  createdAt: string;
}

export interface RuntimeShadowTraceSink {
  append(receipt: RuntimeShadowReceiptV1): Promise<void>;
}

export function normalizeRuntimeShadowConfig(value: unknown): RuntimeShadowConfigV1 {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: raw.enabled === true,
    traceFile: typeof raw.traceFile === "string" && raw.traceFile.trim()
      ? raw.traceFile.trim()
      : undefined,
    maxTraceBytes: typeof raw.maxTraceBytes === "number" && Number.isFinite(raw.maxTraceBytes)
      ? Math.max(16_384, Math.min(100_000_000, Math.floor(raw.maxTraceBytes)))
      : 5_000_000,
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function failureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return `shadow_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}

function sanitizeStages(
  stages: CompatibilityContextShadowResult["trace"],
): CompatibilityContextShadowResult["trace"] {
  return stages.map((stage) => ({
    ...stage,
    detail: stage.stage === "identity" && stage.outcome === "pass"
      ? "resolved"
      : stage.detail.replace(/[^A-Za-z0-9_,.-]/g, "_").slice(0, 120),
  }));
}

export class JsonlRuntimeShadowTraceSink implements RuntimeShadowTraceSink {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 5_000_000,
  ) {}

  async append(receipt: RuntimeShadowReceiptV1): Promise<void> {
    ensurePrivateDirectory(dirname(this.filePath));
    let currentSize = 0;
    try {
      enforcePrivatePath(this.filePath, { kind: "file" });
      currentSize = (await lstat(this.filePath)).size;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (currentSize >= this.maxBytes) {
      const rotated = `${this.filePath}.1`;
      try {
        enforcePrivatePath(rotated, { kind: "file" });
        await rm(rotated, { force: true });
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(this.filePath, rotated);
      enforcePrivatePath(rotated, { kind: "file" });
    }
    await appendPrivateFile(this.filePath, `${JSON.stringify(receipt)}\n`);
  }
}

export async function runDefaultOffRuntimeShadow(params: {
  config: RuntimeShadowConfigV1;
  input: CompatibilityContextShadowInput;
  sink?: RuntimeShadowTraceSink;
  now?: () => Date;
}): Promise<RuntimeShadowReceiptV1> {
  const createdAt = (params.now?.() ?? new Date()).toISOString();
  const ingress = params.input.ingressKind ? { ingressKind: params.input.ingressKind } : {};
  if (!params.config.enabled) {
    return {
      schemaVersion: 1,
      traceId: params.input.traceId,
      ...ingress,
      status: "disabled",
      retrievalInvoked: false,
      candidateCount: 0,
      selectedCount: 0,
      usedTokens: 0,
      stages: [],
      rejectionReasons: [],
      createdAt,
    };
  }

  let receipt: RuntimeShadowReceiptV1;
  try {
    const result = await runCompatibilityContextShadow(params.input);
    receipt = {
      schemaVersion: 1,
      traceId: params.input.traceId,
      ...ingress,
      ...(result.retrievalBoundary?.visibility
        ? { visibility: result.retrievalBoundary.visibility }
        : {}),
      status: result.pack ? "completed" : "skipped",
      principalHash: result.identity.address
        ? shortHash(result.identity.address.principalId)
        : undefined,
      retrievalInvoked: result.retrievalInvoked,
      candidateCount: result.pack?.trace.candidateCount ?? 0,
      selectedCount: result.pack?.trace.selectedCount ?? 0,
      usedTokens: result.pack?.budget.usedTokens ?? 0,
      stages: sanitizeStages(result.trace),
      rejectionReasons: [...new Set(result.pack?.trace.rejected.map((item) => item.reason) ?? [])].sort(),
      ...(result.comparison ? { comparison: result.comparison } : {}),
      createdAt,
    };
  } catch (error) {
    receipt = {
      schemaVersion: 1,
      traceId: params.input.traceId,
      ...ingress,
      status: "failed",
      retrievalInvoked: false,
      candidateCount: 0,
      selectedCount: 0,
      usedTokens: 0,
      stages: [],
      rejectionReasons: [],
      errorCode: failureCode(error),
      createdAt,
    };
  }
  await params.sink?.append(receipt);
  return receipt;
}
