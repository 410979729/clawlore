import type { ContextSectionV1, ContextVerificationV1 } from "./context-pack.js";
import type { MemoryAddressV2 } from "./memory-address.js";

export type SubagentSpawnModeV2 = "isolated" | "fork";

export interface SubagentContextItemV2 {
  memoryId: string;
  section: ContextSectionV1;
  text: string;
  address: MemoryAddressV2;
  verification: ContextVerificationV1;
  readOnly: true;
}

export interface SubagentSnapshotV2 {
  schemaVersion: 2;
  snapshotId: string;
  mode: SubagentSpawnModeV2;
  parentSessionId: string;
  childSessionId: string;
  runId: string;
  taskGoal: string;
  actorAddress: MemoryAddressV2;
  items: SubagentContextItemV2[];
  status: "active" | "revoked";
  createdAt: string;
}

export interface ChildScratchV2 {
  scratchId: string;
  snapshotId: string;
  childSessionId: string;
  content: string;
  retention: "ephemeral" | "working";
  lifecycle: "candidate";
  createdAt: string;
}

export type EpisodeOutcomeV2 = "success" | "failure" | "blocked" | "incomplete";
export type ParentVerificationV2 = "pending" | "parent_verified" | "disputed";
export type ExperienceLifecycleV2 = "candidate" | "promoted" | "quarantined" | "superseded";

export interface ExperienceEpisodeV2 {
  schemaVersion: 2;
  episodeId: string;
  snapshotId: string;
  parentSessionId: string;
  childSessionId: string;
  runId: string;
  taskClass: string;
  taskGoal: string;
  actorAddress: MemoryAddressV2;
  outcome: EpisodeOutcomeV2;
  toolReceiptIds: string[];
  evidence: string[];
  parentVerification: ParentVerificationV2;
  lifecycle: ExperienceLifecycleV2;
  verificationReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookStepV2 {
  stepId: string;
  instruction: string;
  requiredTools: string[];
}

export interface VerificationGateV2 {
  gateId: string;
  description: string;
}

export interface ProceduralPlaybookV2 {
  schemaVersion: 2;
  playbookId: string;
  version: number;
  taskClass: string;
  title: string;
  trigger: string;
  scopeAddress: MemoryAddressV2;
  prerequisites: string[];
  steps: PlaybookStepV2[];
  verificationGates: VerificationGateV2[];
  risks: string[];
  cleanup: string[];
  evidenceEpisodeIds: string[];
  lifecycle: ExperienceLifecycleV2;
  operatorReviewed: boolean;
  predecessorId?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceEventV2 {
  eventId: string;
  entityType: "snapshot" | "scratch" | "episode" | "playbook" | "replay";
  entityId: string;
  eventType: string;
  actor: string;
  reason: string;
  createdAt: string;
}

export interface ReplayEvaluationV2 {
  replayId: string;
  playbookId: string;
  passed: boolean;
  safeToUse: boolean;
  missingTools: string[];
  missingPrerequisites: string[];
  missingSteps: string[];
  missingVerificationGates: string[];
  disabledSteps: string[];
  reason: string;
  evaluatedAt: string;
}
