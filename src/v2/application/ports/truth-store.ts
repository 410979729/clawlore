import type { MemoryAddressV2 } from "../../domain/memory-address.js";
import type {
  MemoryLifecycleV2,
  MemoryMutationReceiptV2,
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
  revisionId?: string;
  operation: "upsert" | "delete" | "purge";
  projection: "fts" | "vector" | "relations";
  attempts: number;
  availableAt: string;
  processedAt?: string;
}

export interface TruthStoreV2Port {
  remember(input: RememberMemoryV2Input): MemoryMutationReceiptV2;
  correct(input: CorrectMemoryV2Input): MemoryMutationReceiptV2;
  forget(input: ForgetMemoryV2Input): MemoryMutationReceiptV2;
  get(itemId: string): MemoryRecordV2 | null;
  queryAccessible(actor: MemoryAddressV2, query: string, limit?: number): MemoryRecordV2[];
  listPendingOutbox(limit?: number): ProjectionOutboxRowV2[];
  markOutboxProcessed(outboxId: string): void;
  recordOutboxFailure(outboxId: string, errorCode: string, retryAt?: string): void;
}
