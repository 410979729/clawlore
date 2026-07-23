import type { MemoryAddressV2 } from "../../domain/memory-address.js";
import type {
  MemoryLifecycleV2,
  MemoryMutationReceiptV2,
  MemoryProjectionV2,
  MemoryRecordV2,
  MemorySourceV2,
  MemoryVerificationV2,
} from "../../domain/memory-record.js";

export interface RememberMemoryV2Input {
  itemId?: string;
  content: string;
  category: string;
  address: MemoryAddressV2;
  lifecycle?: MemoryLifecycleV2;
  verification?: MemoryVerificationV2;
  validUntil?: string;
  source: MemorySourceV2;
  actor: string;
  reason: string;
}

export interface CorrectMemoryV2Input {
  itemId: string;
  content: string;
  source: MemorySourceV2;
  actor: string;
  reason: string;
  verification?: MemoryVerificationV2;
  validUntil?: string;
}

export interface ForgetMemoryV2Input {
  itemId: string;
  hardDelete?: boolean;
  approved?: boolean;
  actor: string;
  reason: string;
}

export interface ProjectionOutboxRowV2 {
  outboxId: string;
  itemId: string;
  /** Monotonic SQLite insertion order used as the per-item commit fence. */
  mutationOrder: number;
  revisionId?: string;
  operation: "upsert" | "delete" | "purge";
  projection: MemoryProjectionV2;
  attempts: number;
  availableAt: string;
  createdAt: string;
  processedAt?: string;
  lastError?: string;
}

export interface ProjectionOutboxClaimV2 {
  row: ProjectionOutboxRowV2;
  owner: string;
  token: string;
  leaseExpiresAt: string;
}

export interface ClaimProjectionOutboxV2Input {
  owner: string;
  leaseDurationMs: number;
  excludeOutboxIds?: string[];
}

export interface TruthStoreV2Port {
  remember(input: RememberMemoryV2Input): MemoryMutationReceiptV2;
  correct(input: CorrectMemoryV2Input): MemoryMutationReceiptV2;
  forget(input: ForgetMemoryV2Input): MemoryMutationReceiptV2;
  get(itemId: string): MemoryRecordV2 | null;
  queryAccessible(actor: MemoryAddressV2, query: string, limit?: number): MemoryRecordV2[];
  listPendingOutbox(limit?: number): ProjectionOutboxRowV2[];
  inspectOutbox(outboxIds: string[]): ProjectionOutboxRowV2[];
  claimNextOutbox(input: ClaimProjectionOutboxV2Input): ProjectionOutboxClaimV2 | null;
  renewOutboxClaim(claim: ProjectionOutboxClaimV2, leaseDurationMs: number): boolean;
  isOutboxClaimCurrent(claim: ProjectionOutboxClaimV2): boolean;
  withProjectionMutationFence<T>(row: ProjectionOutboxRowV2, operation: () => Promise<T>): Promise<T>;
  markOutboxProcessed(claim: ProjectionOutboxClaimV2): boolean;
  recordOutboxFailure(claim: ProjectionOutboxClaimV2, errorCode: string, retryAt?: string): boolean;
}
