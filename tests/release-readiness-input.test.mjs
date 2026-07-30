import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseEvidenceFromEnvironment,
  resolveReleaseReadinessMode,
  shadowEvidenceFromPriorReadiness,
} from "../scripts/release-readiness-input.mjs";

const digest = (character) => character.repeat(64);
const shadow = {
  sampleCount: 30,
  directSamples: 25,
  groupSamples: 5,
  positiveCandidateSamples: 25,
  overlapRatio: 1,
  rankAgreement: 0.96,
  p95LatencyMs: 112,
  forbiddenViolations: 0,
  promptBudgetViolations: 0,
};

function priorReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "ready",
    compatibilityValid: true,
    rollout: {
      ready: true,
      requestedMode: "cutover",
      currentMode: "cutover",
    },
    provenance: {
      configDigest: digest("a"),
      truthSnapshotDigest: digest("b"),
      createdAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
      shadow,
    },
    ...overrides,
  };
}

test("release readiness follows the explicit final runtime mode", () => {
  assert.equal(resolveReleaseReadinessMode("cutover", {}), "cutover");
  assert.equal(resolveReleaseReadinessMode("v2-write", {}), "v2-write");
});

test("auto readiness requires an explicit safe runtime resolution", () => {
  assert.equal(
    resolveReleaseReadinessMode("auto", { CLAWLORE_RESOLVED_RUNTIME_MODE: "disabled" }),
    "disabled",
  );
  assert.equal(
    resolveReleaseReadinessMode("auto", { CLAWLORE_RESOLVED_RUNTIME_MODE: "cutover" }),
    "cutover",
  );
  assert.throws(() => resolveReleaseReadinessMode("auto", {}), /must be disabled or cutover/);
  assert.throws(
    () => resolveReleaseReadinessMode("auto", { CLAWLORE_RESOLVED_RUNTIME_MODE: "shadow" }),
    /must be disabled or cutover/,
  );
});

test("write-mode evidence fails closed unless every operator attestation is explicit", () => {
  const blocked = releaseEvidenceFromEnvironment("cutover", {
    CLAWLORE_RELEASE_GATES_PASSED: "1",
  });
  assert.equal(blocked.fullTests, true);
  assert.equal(blocked.snapshotVerified, false);
  assert.equal(blocked.migrationDrill, false);
  assert.equal(blocked.rollbackDrill, false);
  assert.equal(blocked.legacyHashUnchanged, false);
  assert.equal(blocked.forbiddenScopeViolations, 1);

  const ready = releaseEvidenceFromEnvironment("cutover", {
    CLAWLORE_RELEASE_GATES_PASSED: "1",
    CLAWLORE_SNAPSHOT_VERIFIED: "1",
    CLAWLORE_MIGRATION_DRILL_PASSED: "1",
    CLAWLORE_ROLLBACK_DRILL_PASSED: "1",
    CLAWLORE_LEGACY_HASH_UNCHANGED: "1",
    CLAWLORE_FORBIDDEN_SCOPE_VIOLATIONS: "0",
  });
  assert.deepEqual(
    {
      snapshotVerified: ready.snapshotVerified,
      migrationDrill: ready.migrationDrill,
      rollbackDrill: ready.rollbackDrill,
      legacyHashUnchanged: ready.legacyHashUnchanged,
      forbiddenScopeViolations: ready.forbiddenScopeViolations,
    },
    {
      snapshotVerified: true,
      migrationDrill: true,
      rollbackDrill: true,
      legacyHashUnchanged: true,
      forbiddenScopeViolations: 0,
    },
  );
});

test("prior quality evidence is reusable only for the same live truth and mode", () => {
  const binding = {
    configDigest: digest("a"),
    truthSnapshotDigest: digest("b"),
  };
  assert.deepEqual(
    shadowEvidenceFromPriorReadiness(
      priorReceipt(),
      { mode: "cutover", binding, now: new Date("2026-07-30T00:00:00.000Z") },
    ),
    shadow,
  );
  assert.throws(
    () => shadowEvidenceFromPriorReadiness(
      priorReceipt(),
      { mode: "v2-write", binding, now: new Date("2026-07-30T00:00:00.000Z") },
    ),
    /mode does not match/,
  );
  assert.throws(
    () => shadowEvidenceFromPriorReadiness(
      priorReceipt(),
      {
        mode: "cutover",
        binding: { ...binding, truthSnapshotDigest: digest("c") },
        now: new Date("2026-07-30T00:00:00.000Z"),
      },
    ),
    /truthSnapshotDigest does not match/,
  );
  assert.throws(
    () => shadowEvidenceFromPriorReadiness(
      priorReceipt(),
      { mode: "cutover", binding, now: new Date("2026-08-07T00:00:00.000Z") },
    ),
    /expired/,
  );
  assert.throws(
    () => shadowEvidenceFromPriorReadiness(
      priorReceipt({
        provenance: {
          ...priorReceipt().provenance,
          shadow: { ...shadow, overlapRatio: 1.1 },
        },
      }),
      { mode: "cutover", binding, now: new Date("2026-07-30T01:00:00.000Z") },
    ),
    /ratios must be between zero and one/,
  );
});
