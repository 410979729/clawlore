import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { inspectRuntimeReleaseAuthorityV1, recordRuntimeReleaseAuthorityV1, runtimeReleaseReadinessDigestV1, } from "./runtime-release-authority.js";
import { loadRuntimeRolloutControlsV1, } from "./adapters/openclaw/runtime-rollout-control.js";
function authorityFailure(error) {
    const message = error instanceof Error ? error.message : "";
    if (/^runtime_release_authority_[a-z0-9_:-]+$/i.test(message))
        return message;
    return `runtime_release_authority_record_failed:${diagnosticErrorSummary(error)}`;
}
/**
 * Resolves startup authority for a write-capable runtime.
 *
 * The first activation (and every release/config change) must pass the full
 * exact receipt. Once recorded in the same truth database, later restarts may
 * tolerate only live-truth drift and receipt expiry.
 */
export function authorizeRuntimeReleaseV1(input) {
    let authority = inspectRuntimeReleaseAuthorityV1(input);
    if (authority.status === "invalid") {
        return {
            readiness: undefined,
            verification: undefined,
            errors: [authority.error ?? "runtime_release_authority_invalid"],
            authority,
            authorityRecorded: false,
        };
    }
    let controls = loadRuntimeRolloutControlsV1({
        readinessFile: input.readinessFile,
        expectedBinding: input.expectedBinding,
        expectedMode: input.expectedMode,
        verification: authority.status === "valid"
            ? "durable-release"
            : "full-receipt",
        now: input.now,
    });
    if (authority.status === "valid"
        && controls.readiness
        && controls.errors.length === 0
        && runtimeReleaseReadinessDigestV1(controls.readiness) !== authority.readinessSha256) {
        const fullControls = loadRuntimeRolloutControlsV1({
            readinessFile: input.readinessFile,
            expectedBinding: input.expectedBinding,
            expectedMode: input.expectedMode,
            verification: "full-receipt",
            now: input.now,
        });
        if (fullControls.readiness?.status !== "ready"
            || fullControls.readiness.rollout.ready !== true
            || fullControls.errors.length > 0) {
            return {
                readiness: undefined,
                verification: undefined,
                errors: [...new Set([
                        "runtime_release_authority_readiness_mismatch",
                        ...fullControls.errors,
                    ])].sort(),
                authority,
                authorityRecorded: false,
            };
        }
        controls = fullControls;
        authority = { ...authority, status: "mismatch", mismatchedFields: ["readinessSha256"] };
    }
    if (authority.status === "valid"
        || controls.verification !== "full-receipt"
        || controls.readiness?.status !== "ready"
        || controls.readiness.rollout.ready !== true
        || controls.errors.length > 0) {
        return { ...controls, authority, authorityRecorded: false };
    }
    try {
        authority = recordRuntimeReleaseAuthorityV1({
            sqlitePath: input.sqlitePath,
            expectedBinding: input.expectedBinding,
            expectedMode: input.expectedMode,
            readiness: controls.readiness,
            now: input.now,
        });
        if (authority.status !== "valid") {
            throw new Error("runtime_release_authority_postwrite_invalid");
        }
        return { ...controls, authority, authorityRecorded: true };
    }
    catch (error) {
        return {
            readiness: undefined,
            verification: undefined,
            errors: [...new Set([...controls.errors, authorityFailure(error)])].sort(),
            authority,
            authorityRecorded: false,
        };
    }
}
