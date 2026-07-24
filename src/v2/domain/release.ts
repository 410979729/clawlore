export type ClawLoreRolloutModeV1 = "auto" | "disabled" | "shadow" | "v2-write" | "cutover";

export interface CompatibilitySurfaceV1 {
  productBrand: "ClawLore";
  packageName: "clawlore";
  manifestId: "clawlore";
  configRoot: "plugins.entries.clawlore.config";
  cliPrimary: "clawlore";
  cliAliases: ["scope-recall", "memory-pro"];
  legacyPluginIds: ["scope-recall-openclaw"];
  legacyConfigRoots: ["plugins.entries.scope-recall-openclaw.config"];
  dataDirectoryPolicy: "preserve_existing";
  sourceMetadataPolicy: "preserve_historical";
  compatibilityMajorVersions: 1;
}

export interface RolloutEvidenceV1 {
  focusedTests: boolean;
  fullTests: boolean;
  typecheck: boolean;
  build: boolean;
  moduleBoundaries: boolean;
  releaseGate: boolean;
  snapshotVerified: boolean;
  migrationDrill: boolean;
  rollbackDrill: boolean;
  legacyHashUnchanged: boolean;
  forbiddenScopeViolations: number;
}

export interface ReleaseArtifactBindingV1 {
  sourceCommit: string;
  runtimeDigest: string;
  packageDigest: string;
  lockDigest: string;
  configDigest: string;
  truthSnapshotDigest: string;
  testLogDigest: string;
}

export interface ReleaseReadinessProvenanceV1 extends ReleaseArtifactBindingV1 {
  generatedBy: string;
  createdAt: string;
  expiresAt: string;
  lifecycle: {
    active: number;
    candidate: number;
    archived: number;
    other: number;
  };
  shadow: {
    sampleCount: number;
    directSamples: number;
    groupSamples: number;
    positiveCandidateSamples: number;
    overlapRatio: number;
    rankAgreement: number;
    p95LatencyMs: number;
    forbiddenViolations: number;
    promptBudgetViolations: number;
  };
}

export interface RolloutPreviewV1 {
  schemaVersion: 1;
  rolloutId: string;
  requestedMode: ClawLoreRolloutModeV1;
  currentMode: ClawLoreRolloutModeV1;
  ready: boolean;
  readOnly: boolean;
  blockingReasons: string[];
  steps: Array<{
    order: number;
    action: string;
    mutatesLive: boolean;
    rollback: string;
  }>;
  compatibility: CompatibilitySurfaceV1;
  createdAt: string;
}

export interface ReleaseReadinessReceiptV1 {
  schemaVersion: 1;
  status: "ready" | "blocked";
  compatibilityValid: boolean;
  rollout: RolloutPreviewV1;
  provenance: ReleaseReadinessProvenanceV1;
  responseSchemas: ["memory-action.v2", "memory-center.v1", "projection-convergence.v1", "replay-evaluation.v2"];
}
