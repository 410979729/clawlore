import type { MemoryAddressV2 } from "./memory-address.js";

export type ContextSectionV1 =
  | "profile"
  | "projectFacts"
  | "activeDecisions"
  | "taskContext"
  | "playbooks";

export type ContextFreshnessV1 = "current" | "stale" | "unknown";

export type ContextVerificationV1 =
  | "unverified"
  | "user_confirmed"
  | "tool_verified"
  | "operator_reviewed"
  | "disputed";

export interface ContextMemoryV1 {
  id: string;
  section: ContextSectionV1;
  text: string;
  address: MemoryAddressV2;
  score: number;
  confidence: number;
  estimatedTokens: number;
  verification: ContextVerificationV1;
  freshness: ContextFreshnessV1;
  citation?: {
    sourceType: string;
    sourceId?: string;
    observedAt?: string;
  };
}

export interface ContextConflictV1 {
  memoryId: string;
  reason: string;
  relatedMemoryIds: string[];
}

export interface FreshnessWarningV1 {
  memoryId: string;
  status: Exclude<ContextFreshnessV1, "current">;
  reason: string;
}

export interface ContextPackTraceV1 {
  candidateCount: number;
  policyAllowedCount: number;
  selectedCount: number;
  rejected: Array<{
    memoryId: string;
    stage: "lifecycle" | "verification" | "playbook_review" | "policy" | "budget";
    reason: string;
  }>;
}

export interface ContextPackV1 {
  schemaVersion: 1;
  traceId: string;
  actorAddress: MemoryAddressV2;
  budget: {
    availableTokens: number;
    usedTokens: number;
  };
  profile: ContextMemoryV1[];
  projectFacts: ContextMemoryV1[];
  activeDecisions: ContextMemoryV1[];
  taskContext: ContextMemoryV1[];
  playbooks: ContextMemoryV1[];
  conflicts: ContextConflictV1[];
  freshnessWarnings: FreshnessWarningV1[];
  trace: ContextPackTraceV1;
}

export function contextPackItemCount(pack: ContextPackV1): number {
  return pack.profile.length
    + pack.projectFacts.length
    + pack.activeDecisions.length
    + pack.taskContext.length
    + pack.playbooks.length;
}
