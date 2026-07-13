export type ClawLoreRolloutModeV1 = "disabled" | "shadow" | "v2-write" | "cutover";

export interface CompatibilitySurfaceV1 {
  productBrand: "ClawLore";
  packageName: "scope-recall-openclaw";
  manifestId: "scope-recall-openclaw";
  configRoot: "plugins.entries.scope-recall-openclaw.config";
  cliPrimary: "scope-recall";
  cliAliases: ["memory-pro"];
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
  responseSchemas: ["memory-action.v2", "memory-center.v1", "projection-convergence.v1", "replay-evaluation.v2"];
}
