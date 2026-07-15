import { readFileSync, statSync } from "node:fs";
const MAX_CONTROL_FILE_BYTES = 128 * 1024;
function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("rollout_control_not_object");
    }
    return value;
}
function readPrivateJson(path) {
    const info = statSync(path);
    if (!info.isFile())
        throw new Error("rollout_control_not_file");
    if ((info.mode & 0o077) !== 0)
        throw new Error("rollout_control_permissions_must_be_0600");
    if (info.size <= 0 || info.size > MAX_CONTROL_FILE_BYTES) {
        throw new Error("rollout_control_size_invalid");
    }
    return record(JSON.parse(readFileSync(path, "utf8")));
}
function readiness(value, expectedBinding, now) {
    const rollout = record(value.rollout);
    const provenance = record(value.provenance);
    if (value.schemaVersion !== 1
        || !["ready", "blocked"].includes(String(value.status))
        || rollout.requestedMode !== "shadow"
        || typeof rollout.rolloutId !== "string"
        || typeof provenance.generatedBy !== "string"
        || typeof provenance.createdAt !== "string"
        || typeof provenance.expiresAt !== "string") {
        throw new Error("release_readiness_schema_invalid");
    }
    const createdAt = Date.parse(provenance.createdAt);
    const expiresAt = Date.parse(provenance.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
        throw new Error("release_readiness_freshness_invalid");
    }
    if (createdAt > now.getTime() + 60_000)
        throw new Error("release_readiness_created_in_future");
    if (expiresAt <= now.getTime())
        throw new Error("release_readiness_expired");
    if (expiresAt <= createdAt)
        throw new Error("release_readiness_expiry_order_invalid");
    for (const field of [
        "sourceCommit",
        "runtimeDigest",
        "packageDigest",
        "lockDigest",
        "configDigest",
        "truthSnapshotDigest",
        "testLogDigest",
    ]) {
        if (provenance[field] !== expectedBinding[field]) {
            throw new Error(`release_readiness_provenance_mismatch:${field}`);
        }
    }
    return value;
}
export function loadRuntimeRolloutControlsV1(input) {
    const errors = [];
    let releaseReadiness;
    if (!input.readinessFile)
        errors.push("release_readiness_file_missing");
    else {
        try {
            releaseReadiness = readiness(readPrivateJson(input.readinessFile), input.expectedBinding, input.now?.() ?? new Date());
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : "release_readiness_load_failed");
        }
    }
    return { readiness: releaseReadiness, errors: [...new Set(errors)].sort() };
}
