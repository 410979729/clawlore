import type { ContextSectionV1, ContextVerificationV1 } from "./context-pack.js";
import type { MemoryAddressV2, MemoryVisibility } from "./memory-address.js";
import type { MemoryLifecycleV2 } from "./memory-record.js";

export interface MemoryCenterMemoryV1 {
  itemId: string;
  content: string;
  category: string;
  address: MemoryAddressV2;
  lifecycle: MemoryLifecycleV2;
  verification: ContextVerificationV1;
  updatedAt: string;
  whyRemembered: {
    sourceType: string;
    sourceId?: string;
    observedAt?: string;
    eventType?: string;
    reason?: string;
  };
}

export interface MemoryCenterUsedItemV1 {
  itemId: string;
  section: ContextSectionV1;
  score: number;
  freshness: string;
  whyRecalled: string;
}

export interface MemoryCenterIssueV1 {
  itemId: string;
  issue: "candidate_review" | "disputed" | "stale" | "conflict";
  detail: string;
  relatedItemIds?: string[];
}

export interface MemoryCenterV1 {
  schemaVersion: 1;
  generatedAt: string;
  actorAddress: MemoryAddressV2;
  whatItKnows: MemoryCenterMemoryV1[];
  usedThisTurn: MemoryCenterUsedItemV1[];
  reviewInbox: MemoryCenterIssueV1[];
  corrections: Array<{ eventId: string; itemId: string; reason: string; createdAt: string }>;
  conflictsAndStale: MemoryCenterIssueV1[];
  scopes: Partial<Record<MemoryVisibility, number>>;
  projectionHealth: { pending: number; retrying: number; processed: number };
  providerEgress: Array<{
    purpose: "embedding" | "rerank" | "extraction";
    provider: string;
    enabled: boolean;
    redacted: boolean;
    dataClasses: string[];
  }>;
  capabilities: {
    backup: "encrypted_snapshot";
    portableExport: "explicit_only";
    playbooks: "reviewed_only";
  };
}
