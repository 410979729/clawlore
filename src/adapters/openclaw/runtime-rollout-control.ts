import { readFileSync, statSync } from "node:fs";
import {
  validateRuntimeReleaseReadinessV1,
  type RuntimeReleaseReadinessVerificationV1,
} from "../../application/runtime-release-readiness-validation.js";
import { preparePrivateFileForRead } from "../../file-privacy.js";
import type { ReleaseArtifactBindingV1, ReleaseReadinessReceiptV1 } from "../../v2/domain/release.js";
import { diagnosticErrorSummary } from "../../diagnostic-redaction.js";

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

export interface RuntimeRolloutControlsV1 {
  readiness?: ReleaseReadinessReceiptV1;
  verification?: RuntimeReleaseReadinessVerificationV1;
  errors: string[];
}

export function loadRuntimeRolloutControlsV1(input: {
  readinessFile?: string;
  expectedBinding: ReleaseArtifactBindingV1;
  expectedMode?: ReleaseReadinessReceiptV1["rollout"]["requestedMode"];
  verification?: RuntimeReleaseReadinessVerificationV1;
  now?: () => Date;
}): RuntimeRolloutControlsV1 {
  const errors: string[] = [];
  let releaseReadiness: ReleaseReadinessReceiptV1 | undefined;
  const verification = input.verification ?? "full-receipt";
  if (!input.readinessFile) errors.push("release_readiness_file_missing");
  else {
    try {
      releaseReadiness = validateRuntimeReleaseReadinessV1({
        value: readPrivateJson(input.readinessFile),
        expectedBinding: input.expectedBinding,
        expectedMode: input.expectedMode ?? "shadow",
        verification,
        now: input.now?.() ?? new Date(),
      });
    }
    catch (error) { errors.push(stableRolloutError(error)); }
  }
  return {
    readiness: releaseReadiness,
    verification: releaseReadiness ? verification : undefined,
    errors: [...new Set(errors)].sort(),
  };
}
