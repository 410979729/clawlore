import { createHash } from "node:crypto";
import type { MemoryAddressV2 } from "../domain/memory-address.js";
import { memoryAddressKey, validateMemoryAddress } from "../domain/memory-address.js";
import type { MemoryVerificationV2 } from "../domain/memory-record.js";
import type { TruthStoreV2Port } from "./ports/truth-store.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "../../capture-safety.js";
import {
  assertMemoryAddressIdentifiersSafe,
  normalizeIsoTimestamp,
  normalizeTruthIdentifier,
} from "../domain/truth-write-policy.js";

export interface TurnEnvelopeV2 {
  eventId: string;
  trigger?: "explicit" | "auto_capture" | "reflection" | "digest" | "task_experience";
  sourceIds?: string[];
  address: MemoryAddressV2;
  userText: string;
  assistantText?: string;
  explicitRemember?: boolean;
  toolVerified?: boolean;
  toolReceiptIds?: string[];
  forceCandidate?: boolean;
  observedAt: string;
}

export interface DistillationProposalV2 {
  content: string;
  category: "profile" | "preference" | "fact" | "decision" | "commitment" | "procedure" | "pitfall";
  confidence: number;
  sourceRole: "user" | "assistant" | "tool";
}

export interface DistillationExtractorV2 {
  extract(event: TurnEnvelopeV2): Promise<DistillationProposalV2[]>;
}

export interface DistillationJournalReceiptV2 {
  schemaVersion: 2;
  eventId: string;
  trigger: NonNullable<TurnEnvelopeV2["trigger"]>;
  payloadHash: string;
  proposalCount: number;
  admittedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  itemIds: string[];
  rejectionReasons: string[];
  createdAt: string;
}

export interface DistillationJournalV2 {
  has(eventId: string): Promise<boolean>;
  append(receipt: DistillationJournalReceiptV2): Promise<void>;
}

function normalizedContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const TRIGGERS = new Set<NonNullable<TurnEnvelopeV2["trigger"]>>([
  "explicit", "auto_capture", "reflection", "digest", "task_experience",
]);
const CATEGORIES = new Set<DistillationProposalV2["category"]>([
  "profile", "preference", "fact", "decision", "commitment", "procedure", "pitfall",
]);
const SOURCE_ROLES = new Set<DistillationProposalV2["sourceRole"]>(["user", "assistant", "tool"]);

function safeIdentifiers(values: unknown, label: string, maxItems = 256): string[] {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new Error(`${label} list exceeds the size limit`);
  }
  return [...new Set(values.map((value) => normalizeTruthIdentifier(value, label, 512)))].sort();
}

function safeProviderText(value: unknown, label: string, required: boolean): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || value.length > 64_000) {
    throw new Error(`${label} rejected by safety policy`);
  }
  const sanitized = sanitizeCaptureText(value);
  if (!sanitized) {
    if (required) throw new Error(`${label} rejected by safety policy`);
    return undefined;
  }
  if (!evaluateCaptureSafety(sanitized).allowed) {
    if (required) throw new Error(`${label} rejected by safety policy`);
    return undefined;
  }
  return sanitized;
}

function normalizeEvent(event: TurnEnvelopeV2): TurnEnvelopeV2 {
  if (!event || typeof event !== "object") throw new Error("distillation event is required");
  if (!validateMemoryAddress(event.address).valid) throw new Error("invalid distillation memory address");
  assertMemoryAddressIdentifiersSafe(event.address);
  const trigger = event.trigger ?? "explicit";
  if (!TRIGGERS.has(trigger)) throw new Error("distillation trigger is unsupported");
  return {
    ...event,
    eventId: normalizeTruthIdentifier(event.eventId, "distillation event id", 512),
    trigger,
    sourceIds: safeIdentifiers(event.sourceIds, "distillation source id"),
    toolReceiptIds: safeIdentifiers(event.toolReceiptIds, "distillation tool receipt id"),
    userText: safeProviderText(event.userText, "distillation user text", true)!,
    assistantText: safeProviderText(event.assistantText, "distillation assistant text", false),
    observedAt: normalizeIsoTimestamp(event.observedAt, "distillation observedAt"),
  };
}

function proposalKey(proposal: DistillationProposalV2, address: MemoryAddressV2): string {
  return createHash("sha256")
    .update(`${memoryAddressKey(address)}\n${proposal.category}\n${normalizedContent(proposal.content).toLowerCase()}`)
    .digest("hex");
}

function payloadHash(event: TurnEnvelopeV2): string {
  return createHash("sha256")
    .update(JSON.stringify({
      eventId: event.eventId,
      trigger: event.trigger ?? "explicit",
      sourceIds: event.sourceIds ?? [],
      address: memoryAddressKey(event.address),
      userText: event.userText,
      assistantText: event.assistantText ?? "",
      toolReceiptIds: event.toolReceiptIds ?? [],
    }))
    .digest("hex");
}

function admission(proposal: DistillationProposalV2, event: TurnEnvelopeV2): {
  allowed: boolean;
  reason: string;
  lifecycle: "active" | "candidate";
  verification: MemoryVerificationV2;
} {
  if (!proposal || typeof proposal !== "object"
    || !CATEGORIES.has(proposal.category) || !SOURCE_ROLES.has(proposal.sourceRole)) {
    return { allowed: false, reason: "proposal_shape_invalid", lifecycle: "candidate", verification: "unverified" };
  }
  if (typeof proposal.content !== "string") {
    return { allowed: false, reason: "proposal_shape_invalid", lifecycle: "candidate", verification: "unverified" };
  }
  const content = normalizedContent(proposal.content);
  if (!content || content.length < 4) return { allowed: false, reason: "content_too_short", lifecycle: "candidate", verification: "unverified" };
  if (content.length > 4_000) return { allowed: false, reason: "content_too_long", lifecycle: "candidate", verification: "unverified" };
  const captureSafety = evaluateCaptureSafety(content);
  if (sanitizeCaptureText(content) !== content || !captureSafety.allowed) {
    const reason = captureSafety.reason === "secret" ? "secret_shaped_content" : "capture_unsafe_content";
    return { allowed: false, reason, lifecycle: "candidate", verification: "unverified" };
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0.55) return { allowed: false, reason: "confidence_below_threshold", lifecycle: "candidate", verification: "unverified" };
  if (event.explicitRemember === true && proposal.sourceRole === "user") {
    return { allowed: true, reason: "explicit_user_remember", lifecycle: "active", verification: "user_confirmed" };
  }
  if (event.toolVerified === true && proposal.sourceRole === "tool" && (event.toolReceiptIds?.length ?? 0) > 0) {
    if (event.forceCandidate === true) {
      return { allowed: true, reason: "candidate_review_required", lifecycle: "candidate", verification: "tool_verified" };
    }
    return { allowed: true, reason: "tool_receipt_verified", lifecycle: "active", verification: "tool_verified" };
  }
  return { allowed: true, reason: "candidate_review_required", lifecycle: "candidate", verification: "unverified" };
}

export class UnifiedDistillationPipelineV2 {
  private readonly seen = new Set<string>();

  constructor(
    private readonly truth: TruthStoreV2Port,
    private readonly journal: DistillationJournalV2,
    private readonly extractor: DistillationExtractorV2,
  ) {}

  async process(rawEvent: TurnEnvelopeV2): Promise<DistillationJournalReceiptV2> {
    const event = normalizeEvent(rawEvent);
    if (await this.journal.has(event.eventId)) {
      return {
        schemaVersion: 2, eventId: event.eventId, trigger: event.trigger ?? "explicit",
        payloadHash: payloadHash(event), proposalCount: 0,
        admittedCount: 0, rejectedCount: 0, duplicateCount: 0, itemIds: [],
        rejectionReasons: ["idempotent_event_already_processed"], createdAt: event.observedAt,
      };
    }
    const proposals = await this.extractor.extract(event);
    if (!Array.isArray(proposals) || proposals.length > 256) {
      throw new Error("distillation proposal list exceeds the size limit");
    }
    const itemIds: string[] = [];
    const rejectionReasons: string[] = [];
    let duplicates = 0;
    let rejected = 0;
    for (const proposal of proposals) {
      const decision = admission(proposal, event);
      if (!decision.allowed) { rejected += 1; rejectionReasons.push(decision.reason); continue; }
      const key = proposalKey(proposal, event.address);
      if (this.seen.has(key)) { duplicates += 1; continue; }
      this.seen.add(key);
      const receipt = this.truth.remember({
        content: normalizedContent(proposal.content),
        category: proposal.category,
        address: event.address,
        lifecycle: decision.lifecycle,
        verification: decision.verification,
        source: {
          sourceType: proposal.sourceRole === "tool" ? "tool" : "extractor",
          sourceId: event.eventId,
          observedAt: event.observedAt,
          evidence: {
            trigger: event.trigger ?? "explicit",
            sourceIds: event.sourceIds ?? [],
            ...(proposal.sourceRole === "tool" ? { toolReceiptIds: event.toolReceiptIds ?? [] } : {}),
          },
        },
        actor: `principal:${event.address.principalId}`,
        reason: decision.reason,
      });
      itemIds.push(receipt.itemId);
    }
    const receipt: DistillationJournalReceiptV2 = {
      schemaVersion: 2, eventId: event.eventId, trigger: event.trigger ?? "explicit", payloadHash: payloadHash(event),
      proposalCount: proposals.length, admittedCount: itemIds.length, rejectedCount: rejected,
      duplicateCount: duplicates, itemIds, rejectionReasons: [...new Set(rejectionReasons)].sort(),
      createdAt: event.observedAt,
    };
    await this.journal.append(receipt);
    return receipt;
  }
}

export class InMemoryDistillationJournalV2 implements DistillationJournalV2 {
  readonly receipts: DistillationJournalReceiptV2[] = [];
  async has(eventId: string): Promise<boolean> { return this.receipts.some((item) => item.eventId === eventId); }
  async append(receipt: DistillationJournalReceiptV2): Promise<void> { this.receipts.push(receipt); }
}
