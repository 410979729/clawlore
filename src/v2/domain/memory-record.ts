import type { MemoryAddressV2 } from "./memory-address.js";

export type MemoryLifecycleV2 =
  | "observed"
  | "candidate"
  | "active"
  | "superseded"
  | "archived"
  | "purged";

export type MemoryVerificationV2 =
  | "unverified"
  | "user_confirmed"
  | "tool_verified"
  | "operator_reviewed"
  | "disputed";

export interface MemorySourceV2 {
  sourceType: "user_message" | "file" | "tool" | "extractor" | "operator" | "legacy";
  sourceId?: string;
  observedAt: string;
  evidence?: Record<string, unknown>;
}

export interface MemoryRecordV2 {
  itemId: string;
  revisionId: string;
  revision: number;
  content: string;
  category: string;
  address: MemoryAddressV2;
  lifecycle: MemoryLifecycleV2;
  verification: MemoryVerificationV2;
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryProjectionV2 = "fts" | "vector" | "relations";

export interface MemoryProjectionHandleV2 {
  schemaVersion: 1;
  status: "pending";
  operation: "upsert" | "delete" | "purge";
  expected: MemoryProjectionV2[];
  outboxIds: string[];
}

export interface MemoryMutationReceiptV2 {
  schemaVersion: 2;
  action: "remember" | "correct" | "archive" | "purge";
  itemId: string;
  revisionId?: string;
  previousRevisionId?: string;
  eventId: string;
  outboxIds: string[];
  projection: MemoryProjectionHandleV2;
  committedAt: string;
}
