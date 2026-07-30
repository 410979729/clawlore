import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeReleaseReadinessVerificationV1 } from "./application/runtime-release-readiness-validation.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { readPrivateFile, writePrivateFileAtomic } from "./file-privacy.js";
import type {
  ReleaseArtifactBindingV1,
  ReleaseReadinessReceiptV1,
} from "./v2/domain/release.js";

const RUNTIME_DIAGNOSTIC_FILE = "clawlore-runtime-diagnostic.json";
const MAX_RUNTIME_DIAGNOSTIC_BYTES = 128 * 1024;
export const RUNTIME_DIAGNOSTIC_HEARTBEAT_MS = 10_000;
export const RUNTIME_DIAGNOSTIC_LEASE_MS = 30_000;
const MAX_RUNTIME_DIAGNOSTIC_LEASE_MS = 60_000;
const DIGEST_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{40}$/i;
const INSTANCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELF_PROCESS_FALLBACK_TOKEN = `self:${process.pid}:${Math.trunc(Date.now() - process.uptime() * 1_000)}`;

const WINDOWS_PROCESS_START_SCRIPT = Buffer.from([
  "$ErrorActionPreference='Stop'",
  "$pidValue=[int]$env:CLAWLORE_RUNTIME_PROCESS_ID",
  "$process=Get-Process -Id $pidValue -ErrorAction Stop",
  "[string]$process.StartTime.ToUniversalTime().Ticks",
].join(";"), "utf16le").toString("base64");

export type RuntimeDiagnosticModeV1 = "auto" | "disabled" | "shadow" | "v2-write" | "cutover";

export interface RuntimeInstanceIdentityV1 {
  instanceId: string;
  processId: number;
  processStartToken: string;
}

export interface RuntimeDiagnosticReceiptV2 {
  schemaVersion: 2;
  generatedAt: string;
  instance: RuntimeInstanceIdentityV1;
  lease: {
    heartbeatAt: string;
    expiresAt: string;
  };
  configDigest: string;
  binding?: ReleaseArtifactBindingV1;
  readiness: {
    status: "not_required" | "missing" | "blocked" | "ready";
    bindingVerified: boolean;
    verification: "not_required" | "none" | RuntimeReleaseReadinessVerificationV1;
    expiresAt?: string;
    errors: string[];
  };
  runtime: {
    status: "disabled" | "blocked" | "registered";
    requestedMode: RuntimeDiagnosticModeV1;
    registeredHooks: string[];
    registeredHookCount: number;
    writeEnabled: boolean;
    promptMutationEnabled: boolean;
    contextEngineRegistered: boolean;
    blockingReasons: string[];
  };
}

export interface RuntimeDiagnosticAssessmentV2 {
  schemaVersion: 2;
  ok: boolean;
  status: "disabled" | "registered" | "blocked" | "missing" | "invalid";
  configuredMode: RuntimeDiagnosticModeV1;
  receiptPresent: boolean;
  issues: string[];
  receipt?: RuntimeDiagnosticReceiptV2;
}

export type RuntimeProcessIdentityProbe = (
  identity: RuntimeInstanceIdentityV1,
) => "match" | "dead" | "mismatch" | "unavailable";

type RuntimeCompositionSummary = RuntimeDiagnosticReceiptV2["runtime"];
type EffectiveRuntimeDiagnosticModeV1 = Exclude<RuntimeDiagnosticModeV1, "auto">;

type RuntimeDiagnosticContractV1 = {
  status: "disabled" | "registered";
  registeredHooks: string[];
  writeEnabled: boolean;
  promptMutationEnabled: boolean;
  contextEngineRegistered: boolean;
};

const RUNTIME_DIAGNOSTIC_CONTRACTS: Record<
  EffectiveRuntimeDiagnosticModeV1,
  RuntimeDiagnosticContractV1
> = {
  disabled: {
    status: "disabled",
    registeredHooks: [],
    writeEnabled: false,
    promptMutationEnabled: false,
    contextEngineRegistered: false,
  },
  shadow: {
    status: "registered",
    registeredHooks: ["message_received"],
    writeEnabled: false,
    promptMutationEnabled: false,
    contextEngineRegistered: false,
  },
  "v2-write": {
    status: "registered",
    registeredHooks: [],
    writeEnabled: true,
    promptMutationEnabled: false,
    contextEngineRegistered: false,
  },
  cutover: {
    status: "registered",
    registeredHooks: [],
    writeEnabled: true,
    promptMutationEnabled: true,
    contextEngineRegistered: true,
  },
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime_diagnostic_not_object");
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`runtime_diagnostic_${name}_invalid`);
  }
  return [...new Set(value)].sort();
}

function isoTime(value: unknown, name: string): string {
  const normalized = String(value ?? "");
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`runtime_diagnostic_${name}_invalid`);
  }
  return normalized;
}

function binding(value: unknown): ReleaseArtifactBindingV1 | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  if (!COMMIT_RE.test(String(raw.sourceCommit ?? ""))) {
    throw new Error("runtime_diagnostic_binding_invalid");
  }
  for (const field of [
    "runtimeDigest",
    "packageDigest",
    "lockDigest",
    "configDigest",
    "truthSnapshotDigest",
    "testLogDigest",
  ] as const) {
    if (!DIGEST_RE.test(String(raw[field] ?? ""))) {
      throw new Error("runtime_diagnostic_binding_invalid");
    }
  }
  return raw as unknown as ReleaseArtifactBindingV1;
}

function instanceIdentity(value: unknown): RuntimeInstanceIdentityV1 {
  const raw = record(value);
  const processId = Number(raw.processId);
  const processStartToken = String(raw.processStartToken ?? "");
  const instanceId = String(raw.instanceId ?? "");
  if (
    !INSTANCE_RE.test(instanceId)
    || !Number.isSafeInteger(processId)
    || processId <= 0
    || processStartToken.length < 1
    || processStartToken.length > 256
    || /[\u0000-\u001f\u007f]/.test(processStartToken)
  ) {
    throw new Error("runtime_diagnostic_instance_invalid");
  }
  return { instanceId, processId, processStartToken };
}

function parseRuntimeDiagnosticReceipt(value: unknown): RuntimeDiagnosticReceiptV2 {
  const raw = record(value);
  const lease = record(raw.lease);
  const readiness = record(raw.readiness);
  const runtime = record(raw.runtime);
  const requestedMode = runtime.requestedMode;
  const runtimeStatus = runtime.status;
  const readinessStatus = readiness.status;
  const readinessVerification = readiness.verification
    ?? (readinessStatus === "not_required"
      ? "not_required"
      : readinessStatus === "ready"
        ? "full-receipt"
        : "none");
  const generatedAt = isoTime(raw.generatedAt, "generated_at");
  const heartbeatAt = isoTime(lease.heartbeatAt, "heartbeat_at");
  const leaseExpiresAt = isoTime(lease.expiresAt, "lease_expiry");
  const leaseDuration = Date.parse(leaseExpiresAt) - Date.parse(heartbeatAt);
  if (
    raw.schemaVersion !== 2
    || leaseDuration < 0
    || leaseDuration > MAX_RUNTIME_DIAGNOSTIC_LEASE_MS
    || !DIGEST_RE.test(String(raw.configDigest ?? ""))
    || !["auto", "disabled", "shadow", "v2-write", "cutover"].includes(String(requestedMode))
    || !["disabled", "blocked", "registered"].includes(String(runtimeStatus))
    || !["not_required", "missing", "blocked", "ready"].includes(String(readinessStatus))
    || !["not_required", "none", "full-receipt", "durable-release"].includes(String(readinessVerification))
    || typeof readiness.bindingVerified !== "boolean"
    || typeof runtime.registeredHookCount !== "number"
    || typeof runtime.writeEnabled !== "boolean"
    || typeof runtime.promptMutationEnabled !== "boolean"
    || typeof runtime.contextEngineRegistered !== "boolean"
  ) {
    throw new Error("runtime_diagnostic_schema_invalid");
  }
  const registeredHooks = stringArray(runtime.registeredHooks, "registered_hooks");
  if (runtime.registeredHookCount !== registeredHooks.length) {
    throw new Error("runtime_diagnostic_hook_count_invalid");
  }
  const readinessExpiresAt = readiness.expiresAt;
  if (readinessExpiresAt !== undefined) isoTime(readinessExpiresAt, "readiness_expiry");
  return {
    schemaVersion: 2,
    generatedAt,
    instance: instanceIdentity(raw.instance),
    lease: { heartbeatAt, expiresAt: leaseExpiresAt },
    configDigest: String(raw.configDigest),
    binding: binding(raw.binding),
    readiness: {
      status: readinessStatus as RuntimeDiagnosticReceiptV2["readiness"]["status"],
      bindingVerified: readiness.bindingVerified,
      verification: readinessVerification as RuntimeDiagnosticReceiptV2["readiness"]["verification"],
      ...(readinessExpiresAt === undefined ? {} : { expiresAt: String(readinessExpiresAt) }),
      errors: stringArray(readiness.errors, "readiness_errors"),
    },
    runtime: {
      status: runtimeStatus as RuntimeCompositionSummary["status"],
      requestedMode: requestedMode as RuntimeDiagnosticModeV1,
      registeredHooks,
      registeredHookCount: registeredHooks.length,
      writeEnabled: runtime.writeEnabled,
      promptMutationEnabled: runtime.promptMutationEnabled,
      contextEngineRegistered: runtime.contextEngineRegistered,
      blockingReasons: stringArray(runtime.blockingReasons, "blocking_reasons"),
    },
  };
}

function linuxProcessStartToken(processId: number): string {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error("runtime_process_stat_invalid");
  const fieldsAfterCommand = stat.slice(closeParen + 1).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (!bootId || !/^\d+$/.test(startTicks ?? "")) throw new Error("runtime_process_stat_invalid");
  return `linux:${bootId}:${startTicks}`;
}

function windowsProcessStartToken(processId: number): string {
  const ticks = String(execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    WINDOWS_PROCESS_START_SCRIPT,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CLAWLORE_RUNTIME_PROCESS_ID: String(processId) },
  })).trim();
  if (!/^\d+$/.test(ticks)) throw new Error("runtime_process_start_invalid");
  return `win32:${ticks}`;
}

function processStartToken(processId: number): string {
  if (process.platform === "linux") return linuxProcessStartToken(processId);
  if (process.platform === "win32") return windowsProcessStartToken(processId);
  if (processId === process.pid) return SELF_PROCESS_FALLBACK_TOKEN;
  throw new Error("runtime_process_identity_unsupported");
}

export function createRuntimeInstanceIdentity(): RuntimeInstanceIdentityV1 {
  return {
    instanceId: randomUUID(),
    processId: process.pid,
    processStartToken: processStartToken(process.pid),
  };
}

export function probeRuntimeProcessIdentity(
  identity: RuntimeInstanceIdentityV1,
): ReturnType<RuntimeProcessIdentityProbe> {
  try {
    process.kill(identity.processId, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code !== "EPERM") return "unavailable";
  }
  try {
    return processStartToken(identity.processId) === identity.processStartToken ? "match" : "mismatch";
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return "dead";
    return "unavailable";
  }
}

export function resolveRuntimeDiagnosticFile(resolvedDbPath: string): string {
  return join(resolvedDbPath, RUNTIME_DIAGNOSTIC_FILE);
}

export function configuredRuntimeMode(pluginConfig: Record<string, unknown> | undefined): RuntimeDiagnosticModeV1 {
  const runtime = pluginConfig?.runtime;
  const mode = runtime && typeof runtime === "object"
    ? String((runtime as Record<string, unknown>).mode ?? "")
    : "";
  return ["disabled", "auto", "shadow", "v2-write", "cutover"].includes(mode)
    ? mode as RuntimeDiagnosticModeV1
    : "auto";
}

export function buildRuntimeDiagnosticReceipt(input: {
  configDigest: string;
  binding?: ReleaseArtifactBindingV1;
  readiness?: ReleaseReadinessReceiptV1;
  readinessVerification?: RuntimeReleaseReadinessVerificationV1;
  readinessErrors: string[];
  runtime: {
    status: RuntimeCompositionSummary["status"];
    requestedMode: RuntimeDiagnosticModeV1;
    registeredHooks: string[];
    writeEnabled: boolean;
    promptMutationEnabled: boolean;
    contextEngineRegistered: boolean;
    blockingReasons: string[];
  };
  instance?: RuntimeInstanceIdentityV1;
  leaseMs?: number;
  now?: () => Date;
}): RuntimeDiagnosticReceiptV2 {
  const mode = input.runtime.requestedMode;
  const readinessStatus = mode === "disabled"
    ? "not_required"
    : input.readiness?.status === "ready"
      ? "ready"
      : input.readiness?.status === "blocked"
        ? "blocked"
        : "missing";
  const now = input.now?.() ?? new Date();
  const leaseMs = input.leaseMs ?? RUNTIME_DIAGNOSTIC_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > MAX_RUNTIME_DIAGNOSTIC_LEASE_MS) {
    throw new Error("runtime_diagnostic_lease_duration_invalid");
  }
  const readinessVerification = mode === "disabled"
    ? "not_required"
    : input.readiness
      ? input.readinessVerification ?? "full-receipt"
      : "none";
  return parseRuntimeDiagnosticReceipt({
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    instance: input.instance ?? createRuntimeInstanceIdentity(),
    lease: {
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    },
    configDigest: input.configDigest,
    binding: input.binding,
    readiness: {
      status: readinessStatus,
      bindingVerified: mode === "disabled" || Boolean(
        input.readiness
        && input.readinessErrors.length === 0
        && readinessVerification !== "none",
      ),
      verification: readinessVerification,
      expiresAt: input.readiness?.provenance.expiresAt,
      errors: [...new Set(input.readinessErrors)].sort(),
    },
    runtime: {
      ...input.runtime,
      registeredHookCount: input.runtime.registeredHooks.length,
    },
  });
}

export function renewRuntimeDiagnosticReceipt(
  receipt: RuntimeDiagnosticReceiptV2,
  now: () => Date = () => new Date(),
): RuntimeDiagnosticReceiptV2 {
  const current = parseRuntimeDiagnosticReceipt(receipt);
  const heartbeatAt = now();
  return parseRuntimeDiagnosticReceipt({
    ...current,
    generatedAt: heartbeatAt.toISOString(),
    lease: {
      heartbeatAt: heartbeatAt.toISOString(),
      expiresAt: new Date(heartbeatAt.getTime() + RUNTIME_DIAGNOSTIC_LEASE_MS).toISOString(),
    },
  });
}

export function invalidateRuntimeDiagnosticReceipt(
  receipt: RuntimeDiagnosticReceiptV2,
  reason = "runtime_diagnostic_stopped",
  now: () => Date = () => new Date(),
): RuntimeDiagnosticReceiptV2 {
  const current = parseRuntimeDiagnosticReceipt(receipt);
  const stoppedAt = now().toISOString();
  return parseRuntimeDiagnosticReceipt({
    ...current,
    generatedAt: stoppedAt,
    lease: { heartbeatAt: stoppedAt, expiresAt: stoppedAt },
    runtime: {
      ...current.runtime,
      status: current.runtime.requestedMode === "disabled" ? "disabled" : "blocked",
      registeredHooks: [],
      registeredHookCount: 0,
      blockingReasons: current.runtime.requestedMode === "disabled"
        ? []
        : [...new Set([...current.runtime.blockingReasons, reason])],
    },
  });
}

export async function writeRuntimeDiagnosticReceipt(
  file: string,
  receipt: RuntimeDiagnosticReceiptV2,
): Promise<void> {
  await writePrivateFileAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function readRuntimeDiagnosticReceipt(file: string): Promise<RuntimeDiagnosticReceiptV2> {
  const size = statSync(file).size;
  if (size <= 0 || size > MAX_RUNTIME_DIAGNOSTIC_BYTES) {
    throw new Error("runtime_diagnostic_size_invalid");
  }
  return parseRuntimeDiagnosticReceipt(JSON.parse(await readPrivateFile(file)));
}

export async function assessRuntimeDiagnostic(input: {
  file?: string;
  configuredMode: RuntimeDiagnosticModeV1;
  configDigest: string;
  now?: () => Date;
  processIdentityProbe?: RuntimeProcessIdentityProbe;
}): Promise<RuntimeDiagnosticAssessmentV2> {
  if (!input.file || !existsSync(input.file)) {
    const disabled = input.configuredMode === "disabled";
    return {
      schemaVersion: 2,
      ok: disabled,
      status: disabled ? "disabled" : "missing",
      configuredMode: input.configuredMode,
      receiptPresent: false,
      issues: disabled ? [] : ["runtime_diagnostic_missing"],
    };
  }

  let receipt: RuntimeDiagnosticReceiptV2;
  try {
    receipt = await readRuntimeDiagnosticReceipt(input.file);
  } catch (error) {
    return {
      schemaVersion: 2,
      ok: false,
      status: "invalid",
      configuredMode: input.configuredMode,
      receiptPresent: true,
      issues: [`runtime_diagnostic_invalid:${diagnosticErrorSummary(error)}`],
    };
  }

  const issues: string[] = [];
  const now = input.now?.() ?? new Date();
  const nowMs = now.getTime();
  const receiptMode = receipt.runtime.requestedMode;
  const modeMatches = input.configuredMode === "auto"
    ? receiptMode === "disabled" || receiptMode === "cutover"
    : receiptMode === input.configuredMode;
  if (!modeMatches) issues.push("runtime_diagnostic_mode_mismatch");
  if (receiptMode === "auto") issues.push("runtime_diagnostic_auto_mode_unresolved");
  const effectiveMode = receiptMode === "auto" ? undefined : receiptMode;

  if (effectiveMode === "disabled") {
    const contract = RUNTIME_DIAGNOSTIC_CONTRACTS.disabled;
    if (receipt.runtime.status !== contract.status) issues.push("runtime_diagnostic_disabled_status_mismatch");
    if (receipt.runtime.registeredHookCount !== 0) issues.push("runtime_diagnostic_disabled_hooks_present");
  } else {
    if (Date.parse(receipt.generatedAt) > nowMs + 60_000) issues.push("runtime_diagnostic_created_in_future");
    if (Date.parse(receipt.lease.heartbeatAt) > nowMs + 60_000) issues.push("runtime_diagnostic_heartbeat_in_future");
    if (Date.parse(receipt.lease.expiresAt) <= nowMs) issues.push("runtime_diagnostic_lease_expired");
    const processStatus = (input.processIdentityProbe ?? probeRuntimeProcessIdentity)(receipt.instance);
    if (processStatus === "dead") issues.push("runtime_diagnostic_process_dead");
    else if (processStatus === "mismatch") issues.push("runtime_diagnostic_process_identity_mismatch");
    else if (processStatus === "unavailable") issues.push("runtime_diagnostic_process_identity_unavailable");
    if (receipt.configDigest !== input.configDigest) issues.push("runtime_diagnostic_config_digest_mismatch");
    if (receipt.binding && receipt.binding.configDigest !== receipt.configDigest) {
      issues.push("runtime_diagnostic_binding_config_mismatch");
    }
    if (!receipt.binding) issues.push("runtime_diagnostic_binding_missing");
    if (receipt.readiness.status !== "ready") issues.push("runtime_diagnostic_readiness_not_ready");
    if (!receipt.readiness.bindingVerified) issues.push("runtime_diagnostic_binding_unverified");
    if (receipt.readiness.verification === "none" || receipt.readiness.verification === "not_required") {
      issues.push("runtime_diagnostic_readiness_verification_missing");
    }
    if (
      receipt.readiness.verification === "durable-release"
      && effectiveMode !== "v2-write"
      && effectiveMode !== "cutover"
    ) {
      issues.push("runtime_diagnostic_durable_authority_mode_invalid");
    }
    if (receipt.readiness.errors.length > 0) issues.push(...receipt.readiness.errors);
    if (
      receipt.readiness.verification !== "durable-release"
      && (!receipt.readiness.expiresAt || Date.parse(receipt.readiness.expiresAt) <= nowMs)
    ) {
      issues.push("runtime_diagnostic_readiness_expired");
    }
  }
  if (effectiveMode) {
    const contract = RUNTIME_DIAGNOSTIC_CONTRACTS[effectiveMode];
    if (receipt.runtime.status !== contract.status && effectiveMode !== "disabled") {
      issues.push("runtime_diagnostic_not_registered");
    }
    if (
      receipt.runtime.registeredHooks.length !== contract.registeredHooks.length
      || receipt.runtime.registeredHooks.some((hook, index) => hook !== contract.registeredHooks[index])
    ) {
      issues.push("runtime_diagnostic_hook_contract_mismatch");
    }
    if (receipt.runtime.writeEnabled !== contract.writeEnabled) {
      issues.push(contract.writeEnabled
        ? "runtime_diagnostic_writes_disabled"
        : "runtime_diagnostic_writes_enabled");
    }
    if (receipt.runtime.promptMutationEnabled !== contract.promptMutationEnabled) {
      issues.push(contract.promptMutationEnabled
        ? "runtime_diagnostic_prompt_mutation_disabled"
        : "runtime_diagnostic_prompt_mutation_enabled");
    }
    if (receipt.runtime.contextEngineRegistered !== contract.contextEngineRegistered) {
      issues.push(contract.contextEngineRegistered
        ? "runtime_diagnostic_context_engine_not_registered"
        : "runtime_diagnostic_context_engine_registered");
    }
  }
  if (effectiveMode !== "disabled" && receipt.runtime.blockingReasons.length > 0) {
    issues.push(...receipt.runtime.blockingReasons);
  }

  const uniqueIssues = [...new Set(issues)].sort();
  return {
    schemaVersion: 2,
    ok: uniqueIssues.length === 0,
    status: uniqueIssues.length > 0
      ? "blocked"
      : effectiveMode === "disabled"
        ? "disabled"
        : "registered",
    configuredMode: input.configuredMode,
    receiptPresent: true,
    issues: uniqueIssues,
    receipt,
  };
}
