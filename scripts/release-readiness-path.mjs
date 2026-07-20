import { isAbsolute, resolve } from "node:path";

export function assertFinalReadinessPointer({ configuredReadinessFile, readinessOut }) {
  const configured = String(configuredReadinessFile ?? "").trim();
  if (!configured) throw new Error("release_readiness_pointer_missing");
  if (!isAbsolute(configured)) throw new Error("release_readiness_pointer_must_be_absolute");
  if (resolve(configured) !== resolve(readinessOut)) {
    throw new Error("release_readiness_pointer_output_mismatch");
  }
  return resolve(configured);
}
