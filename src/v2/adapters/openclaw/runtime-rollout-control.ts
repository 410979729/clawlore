import { readFileSync, statSync } from "node:fs";
import type { ReleaseReadinessReceiptV1 } from "../../domain/release.js";
import type { RuntimeRolloutApprovalV1 } from "./runtime-composition-root.js";

const MAX_CONTROL_FILE_BYTES = 128 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rollout_control_not_object");
  }
  return value as Record<string, unknown>;
}

function readPrivateJson(path: string): Record<string, unknown> {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("rollout_control_not_file");
  if ((info.mode & 0o077) !== 0) throw new Error("rollout_control_permissions_must_be_0600");
  if (info.size <= 0 || info.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error("rollout_control_size_invalid");
  }
  return record(JSON.parse(readFileSync(path, "utf8")));
}

function readiness(value: Record<string, unknown>): ReleaseReadinessReceiptV1 {
  const rollout = record(value.rollout);
  if (
    value.schemaVersion !== 1
    || !["ready", "blocked"].includes(String(value.status))
    || rollout.requestedMode !== "shadow"
    || typeof rollout.rolloutId !== "string"
  ) {
    throw new Error("release_readiness_schema_invalid");
  }
  return value as unknown as ReleaseReadinessReceiptV1;
}

function approval(value: Record<string, unknown>): RuntimeRolloutApprovalV1 {
  if (
    value.schemaVersion !== 1
    || value.mode !== "shadow"
    || value.decision !== "approved"
    || typeof value.rolloutId !== "string"
    || typeof value.actor !== "string"
    || typeof value.approvedAt !== "string"
  ) {
    throw new Error("rollout_approval_schema_invalid");
  }
  return value as unknown as RuntimeRolloutApprovalV1;
}

export function loadRuntimeRolloutControlsV1(input: {
  readinessFile?: string;
  approvalFile?: string;
}): {
  readiness?: ReleaseReadinessReceiptV1;
  approval?: RuntimeRolloutApprovalV1;
  errors: string[];
} {
  const errors: string[] = [];
  let releaseReadiness: ReleaseReadinessReceiptV1 | undefined;
  let rolloutApproval: RuntimeRolloutApprovalV1 | undefined;
  if (!input.readinessFile) errors.push("release_readiness_file_missing");
  else {
    try { releaseReadiness = readiness(readPrivateJson(input.readinessFile)); }
    catch (error) { errors.push(error instanceof Error ? error.message : "release_readiness_load_failed"); }
  }
  if (!input.approvalFile) errors.push("rollout_approval_file_missing");
  else {
    try { rolloutApproval = approval(readPrivateJson(input.approvalFile)); }
    catch (error) { errors.push(error instanceof Error ? error.message : "rollout_approval_load_failed"); }
  }
  return { readiness: releaseReadiness, approval: rolloutApproval, errors: [...new Set(errors)].sort() };
}
