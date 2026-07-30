export const RELEASE_IMMUTABLE_BINDING_FIELDS_V1 = [
    "sourceCommit",
    "runtimeDigest",
    "packageDigest",
    "lockDigest",
    "configDigest",
    "testLogDigest",
];
const DIGEST_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{40}$/i;
function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("rollout_control_not_object");
    }
    return value;
}
/**
 * Validates the release receipt used by the runtime startup gate.
 *
 * A durable release authority may relax only the two properties that are
 * expected to drift after a successful cutover: receipt expiry and the live
 * truth snapshot. Code, package, lockfile, configuration, and test evidence
 * remain exact on every restart.
 */
export function validateRuntimeReleaseReadinessV1(input) {
    if (input.verification === "durable-release"
        && input.expectedMode !== "v2-write"
        && input.expectedMode !== "cutover") {
        throw new Error("release_readiness_durable_mode_invalid");
    }
    const value = record(input.value);
    const rollout = record(value.rollout);
    const provenance = record(value.provenance);
    if (value.schemaVersion !== 1
        || !["ready", "blocked"].includes(String(value.status))
        || typeof value.compatibilityValid !== "boolean"
        || rollout.requestedMode !== input.expectedMode
        || typeof rollout.rolloutId !== "string"
        || typeof rollout.ready !== "boolean"
        || typeof provenance.generatedBy !== "string"
        || typeof provenance.createdAt !== "string"
        || typeof provenance.expiresAt !== "string") {
        throw new Error("release_readiness_schema_invalid");
    }
    if (value.status === "ready"
        && (value.compatibilityValid !== true || rollout.ready !== true)) {
        throw new Error("release_readiness_ready_state_invalid");
    }
    if (!COMMIT_RE.test(String(provenance.sourceCommit ?? ""))) {
        throw new Error("release_readiness_provenance_invalid:sourceCommit");
    }
    for (const field of [
        "runtimeDigest",
        "packageDigest",
        "lockDigest",
        "configDigest",
        "truthSnapshotDigest",
        "testLogDigest",
    ]) {
        if (!DIGEST_RE.test(String(provenance[field] ?? ""))) {
            throw new Error(`release_readiness_provenance_invalid:${field}`);
        }
    }
    if (!provenance.generatedBy.trim()) {
        throw new Error("release_readiness_generator_missing");
    }
    const createdAt = Date.parse(provenance.createdAt);
    const expiresAt = Date.parse(provenance.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
        throw new Error("release_readiness_freshness_invalid");
    }
    if (createdAt > input.now.getTime() + 60_000) {
        throw new Error("release_readiness_created_in_future");
    }
    if (expiresAt <= createdAt) {
        throw new Error("release_readiness_expiry_order_invalid");
    }
    if (input.verification === "full-receipt"
        && expiresAt <= input.now.getTime()) {
        throw new Error("release_readiness_expired");
    }
    for (const field of RELEASE_IMMUTABLE_BINDING_FIELDS_V1) {
        if (provenance[field] !== input.expectedBinding[field]) {
            throw new Error(`release_readiness_provenance_mismatch:${field}`);
        }
    }
    if (input.verification === "full-receipt"
        && provenance.truthSnapshotDigest !== input.expectedBinding.truthSnapshotDigest) {
        throw new Error("release_readiness_provenance_mismatch:truthSnapshotDigest");
    }
    return value;
}
