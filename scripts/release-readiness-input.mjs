const EXPLICIT_MODES = new Set(["disabled", "shadow", "v2-write", "cutover"]);
const AUTO_RESOLVED_MODES = new Set(["disabled", "cutover"]);
const WRITE_MODES = new Set(["v2-write", "cutover"]);

function enabled(env, name) {
  return String(env[name] ?? "").trim() === "1";
}

function explicitNonNegativeInteger(env, name, required) {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return required ? 1 : 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

export function resolveReleaseReadinessMode(configuredMode, env = process.env) {
  const mode = String(configuredMode ?? "").trim() || "auto";
  if (EXPLICIT_MODES.has(mode)) return mode;
  if (mode !== "auto") {
    throw new Error(`unsupported configured runtime mode: ${mode}`);
  }
  const resolved = String(env.CLAWLORE_RESOLVED_RUNTIME_MODE ?? "").trim();
  if (!AUTO_RESOLVED_MODES.has(resolved)) {
    throw new Error(
      "CLAWLORE_RESOLVED_RUNTIME_MODE must be disabled or cutover when configured runtime mode is auto",
    );
  }
  return resolved;
}

export function releaseEvidenceFromEnvironment(mode, env = process.env) {
  if (!EXPLICIT_MODES.has(mode)) {
    throw new Error(`unsupported release readiness mode: ${mode}`);
  }
  const releaseGatesPassed = enabled(env, "CLAWLORE_RELEASE_GATES_PASSED");
  const writeMode = WRITE_MODES.has(mode);
  return {
    focusedTests: releaseGatesPassed,
    fullTests: releaseGatesPassed,
    typecheck: releaseGatesPassed,
    build: releaseGatesPassed,
    moduleBoundaries: releaseGatesPassed,
    releaseGate: releaseGatesPassed,
    snapshotVerified: writeMode && enabled(env, "CLAWLORE_SNAPSHOT_VERIFIED"),
    migrationDrill: writeMode && enabled(env, "CLAWLORE_MIGRATION_DRILL_PASSED"),
    rollbackDrill: writeMode && enabled(env, "CLAWLORE_ROLLBACK_DRILL_PASSED"),
    legacyHashUnchanged: writeMode && enabled(env, "CLAWLORE_LEGACY_HASH_UNCHANGED"),
    forbiddenScopeViolations: explicitNonNegativeInteger(
      env,
      "CLAWLORE_FORBIDDEN_SCOPE_VIOLATIONS",
      writeMode,
    ),
  };
}

function requireDigestMatch(receipt, binding, field) {
  if (receipt?.provenance?.[field] !== binding?.[field]) {
    throw new Error(`prior readiness ${field} does not match current release binding`);
  }
}

function validateShadowEvidence(shadow) {
  const integerFields = [
    "sampleCount",
    "directSamples",
    "groupSamples",
    "positiveCandidateSamples",
    "forbiddenViolations",
    "promptBudgetViolations",
  ];
  const numberFields = ["overlapRatio", "rankAgreement", "p95LatencyMs"];
  for (const field of integerFields) {
    if (!Number.isInteger(shadow?.[field]) || shadow[field] < 0) {
      throw new Error(`prior readiness shadow.${field} is invalid`);
    }
  }
  for (const field of numberFields) {
    if (!Number.isFinite(shadow?.[field]) || shadow[field] < 0) {
      throw new Error(`prior readiness shadow.${field} is invalid`);
    }
  }
  if (shadow.overlapRatio > 1 || shadow.rankAgreement > 1) {
    throw new Error("prior readiness shadow ratios must be between zero and one");
  }
  for (const field of ["directSamples", "groupSamples", "positiveCandidateSamples"]) {
    if (shadow[field] > shadow.sampleCount) {
      throw new Error(`prior readiness shadow.${field} exceeds sampleCount`);
    }
  }
}

export function shadowEvidenceFromPriorReadiness(
  receipt,
  { mode, binding, now = new Date() },
) {
  if (
    receipt?.schemaVersion !== 1
    || receipt?.status !== "ready"
    || receipt?.compatibilityValid !== true
    || receipt?.rollout?.ready !== true
  ) {
    throw new Error("prior readiness is not a ready schema-v1 receipt");
  }
  if (receipt.rollout.requestedMode !== mode || receipt.rollout.currentMode !== mode) {
    throw new Error("prior readiness mode does not match the final configured runtime mode");
  }
  const createdAt = Date.parse(receipt?.provenance?.createdAt);
  const expiresAt = Date.parse(receipt?.provenance?.expiresAt);
  if (!Number.isFinite(createdAt) || createdAt > now.getTime() + 60_000) {
    throw new Error("prior readiness has an invalid or future creation time");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt <= createdAt) {
    throw new Error("prior readiness is expired or has an invalid expiry");
  }
  requireDigestMatch(receipt, binding, "configDigest");
  requireDigestMatch(receipt, binding, "truthSnapshotDigest");
  validateShadowEvidence(receipt.provenance.shadow);
  return { ...receipt.provenance.shadow };
}
