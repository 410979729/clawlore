import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { enforcePrivatePath } from "../../../file-privacy.js";
import { runCompatibilityContextShadow, } from "./compatibility-context-adapter.js";
export function normalizeRuntimeShadowConfig(value) {
    const raw = value && typeof value === "object" ? value : {};
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
function shortHash(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function failureCode(error) {
    const name = error instanceof Error ? error.name : "Error";
    return `shadow_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}
function sanitizeStages(stages) {
    return stages.map((stage) => ({
        ...stage,
        detail: stage.stage === "identity" && stage.outcome === "pass"
            ? "resolved"
            : stage.detail.replace(/[^A-Za-z0-9_,.-]/g, "_").slice(0, 120),
    }));
}
export class JsonlRuntimeShadowTraceSink {
    filePath;
    maxBytes;
    constructor(filePath, maxBytes = 5_000_000) {
        this.filePath = filePath;
        this.maxBytes = maxBytes;
    }
    async append(receipt) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const currentSize = await stat(this.filePath).then((value) => value.size).catch(() => 0);
        if (currentSize >= this.maxBytes) {
            await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
        }
        await appendFile(this.filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
        enforcePrivatePath(this.filePath, { kind: "file" });
    }
}
export async function runDefaultOffRuntimeShadow(params) {
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
    let receipt;
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
    }
    catch (error) {
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
