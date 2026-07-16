import { readFileSync, statSync } from "node:fs";
import { preparePrivateFileForRead } from "../../../file-privacy.js";
import type { ReleaseArtifactBindingV1, ReleaseReadinessReceiptV1 } from "../../domain/release.js";
import { diagnosticErrorSummary } from "../../../diagnostic-redaction.js";

const MAX_CONTROL_FILE_BYTES = 128 * 1024;

function stableRolloutError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^(?:release_|rollout_control_)[a-z0-9_:-]+$/i.test(message)) return message;
  return `release_readiness_load_failed:${diagnosticErrorSummary(error)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rollout_control_not_object");
  }
  return value as Record<string, unknown>;
}

function readPrivateJson(path: string): Record<string, unknown> {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile()) throw new Error("rollout_control_not_file");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("rollout_control_permissions_must_be_0600");
  }
  if (info.size <= 0 || info.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error("rollout_control_size_invalid");
  }
  return record(JSON.parse(readFileSync(path, "utf8")));
}

function readiness(
  value: Record<string, unknown>,
  expectedBinding: ReleaseArtifactBindingV1,
  now: Date,
): ReleaseReadinessReceiptV1 {
  const rollout = record(value.rollout);
  const provenance = record(value.provenance);
  if (
    value.schemaVersion !== 1
    || !["ready", "blocked"].includes(String(value.status))
    || rollout.requestedMode !== "shadow"
    || typeof rollout.rolloutId !== "string"
    || typeof provenance.generatedBy !== "string"
    || typeof provenance.createdAt !== "string"
    || typeof provenance.expiresAt !== "string"
  ) {
    throw new Error("release_readiness_schema_invalid");
  }
  const createdAt = Date.parse(provenance.createdAt as string);
  const expiresAt = Date.parse(provenance.expiresAt as string);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw new Error("release_readiness_freshness_invalid");
  }
  if (createdAt > now.getTime() + 60_000) throw new Error("release_readiness_created_in_future");
  if (expiresAt <= now.getTime()) throw new Error("release_readiness_expired");
  if (expiresAt <= createdAt) throw new Error("release_readiness_expiry_order_invalid");
  for (const field of [
    "sourceCommit",
    "runtimeDigest",
    "packageDigest",
    "lockDigest",
    "configDigest",
    "truthSnapshotDigest",
    "testLogDigest",
  ] as const) {
    if (provenance[field] !== expectedBinding[field]) {
      throw new Error(`release_readiness_provenance_mismatch:${field}`);
    }
  }
  return value as unknown as ReleaseReadinessReceiptV1;
}

export function loadRuntimeRolloutControlsV1(input: {
  readinessFile?: string;
  expectedBinding: ReleaseArtifactBindingV1;
  now?: () => Date;
}): {
  readiness?: ReleaseReadinessReceiptV1;
  errors: string[];
} {
  const errors: string[] = [];
  let releaseReadiness: ReleaseReadinessReceiptV1 | undefined;
  if (!input.readinessFile) errors.push("release_readiness_file_missing");
  else {
    try {
      releaseReadiness = readiness(
        readPrivateJson(input.readinessFile),
        input.expectedBinding,
        input.now?.() ?? new Date(),
      );
    }
    catch (error) { errors.push(stableRolloutError(error)); }
  }
  return { readiness: releaseReadiness, errors: [...new Set(errors)].sort() };
}
