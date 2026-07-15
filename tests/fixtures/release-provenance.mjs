const digest = (character) => character.repeat(64);

export function releaseProvenance(overrides = {}) {
  return {
    sourceCommit: "a".repeat(40),
    runtimeDigest: digest("1"),
    packageDigest: digest("2"),
    lockDigest: digest("3"),
    configDigest: digest("4"),
    truthSnapshotDigest: digest("5"),
    testLogDigest: digest("6"),
    generatedBy: "test-fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    lifecycle: { active: 10, candidate: 2, archived: 1, other: 0 },
    shadow: {
      sampleCount: 40,
      directSamples: 30,
      groupSamples: 10,
      positiveCandidateSamples: 20,
      overlapRatio: 0.9,
      rankAgreement: 0.9,
      p95LatencyMs: 300,
      forbiddenViolations: 0,
      promptBudgetViolations: 0,
    },
    ...overrides,
  };
}

export function artifactBinding(provenance = releaseProvenance()) {
  return {
    sourceCommit: provenance.sourceCommit,
    runtimeDigest: provenance.runtimeDigest,
    packageDigest: provenance.packageDigest,
    lockDigest: provenance.lockDigest,
    configDigest: provenance.configDigest,
    truthSnapshotDigest: provenance.truthSnapshotDigest,
    testLogDigest: provenance.testLogDigest,
  };
}
