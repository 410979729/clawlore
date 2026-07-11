import type { MemoryAddressV2, MemoryVisibility } from "../../domain/memory-address.js";
import type { MemoryLifecycleV2, MemoryVerificationV2 } from "../../domain/memory-record.js";

export interface MemoryCenterRowV1 {
  itemId: string;
  content: string;
  category: string;
  address: MemoryAddressV2;
  lifecycle: MemoryLifecycleV2;
  verification: MemoryVerificationV2;
  validUntil?: string;
  updatedAt: string;
  sourceType?: string;
  sourceId?: string;
  observedAt?: string;
  latestEventType?: string;
  latestReason?: string;
}

export interface MemoryCenterEventRowV1 {
  eventId: string;
  itemId: string;
  eventType: string;
  reason: string;
  createdAt: string;
}

export interface MemoryCenterRelationRowV1 {
  relationType: string;
  fromItemId: string;
  toItemId: string;
  createdAt: string;
}

export interface MemoryCenterProjectionHealthV1 {
  pending: number;
  retrying: number;
  processed: number;
}

export interface MemoryCenterReadPortV1 {
  listMemoryCenterRows(actor: MemoryAddressV2, limit?: number): MemoryCenterRowV1[];
  listMemoryCenterEvents(actor: MemoryAddressV2, limit?: number): MemoryCenterEventRowV1[];
  listMemoryCenterRelations(actor: MemoryAddressV2, limit?: number): MemoryCenterRelationRowV1[];
  getMemoryCenterProjectionHealth(actor: MemoryAddressV2): MemoryCenterProjectionHealthV1;
}

export type MemoryCenterScopeCountsV1 = Partial<Record<MemoryVisibility, number>>;
