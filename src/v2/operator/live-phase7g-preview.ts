import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  CandidateAttributionEvidenceV1,
  CandidatePromotionReviewRowV1,
  LegacyCandidateClassificationV1,
} from "../application/candidate-promotion-policy.js";
import { planCandidatePromotionsV1 } from "../application/candidate-promotion-policy.js";
import {
  buildPhase7GControlBundleV1,
  PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1,
  type CompatibilityBackfillPlanEvidenceV1,
  type Phase7GControlBundleV1,
} from "../application/phase7g-rollout-controls.js";
import type { MemoryAddressV2 } from "../domain/memory-address.js";
import type { MemoryLifecycleV2, MemoryVerificationV2 } from "../domain/memory-record.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 128 * 1024;

interface LiveCandidateRow {
  item_id: string;
  lifecycle: string;
  verification: string;
  address_json: string;
  evidence_json: string;
  external_id: string | null;
}

interface SnapshotReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-encrypted-snapshot";
  createdAt: string;
  status: "pass";
  authorizesV2Writes: false;
  archiveSha256: string;
  sourceStableDuringBackup: true;
  restoreVerified: true;
  restoredPlaintextRemoved: true;
  snapshot: {
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

export interface LivePhase7GPreviewReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-phase7g-live-preview";
  createdAt: string;
  readOnly: true;
  emitsMemoryContent: false;
  sourceUnchanged: true;
  snapshotReceiptSha256: string;
  compatibilityPlan: CompatibilityBackfillPlanEvidenceV1;
  candidatePromotionPlan: ReturnType<typeof planCandidatePromotionsV1>;
  controls: Phase7GControlBundleV1;
  liveMutation: {
    compatibilityProjectionCreated: false;
    lifecycleRowsChanged: 0;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateSnapshotReceipt(path: string): { value: SnapshotReceiptV1; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("snapshot receipt must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as SnapshotReceiptV1;
  if (
    value.schemaVersion !== 1
    || value.phase !== "clawlore-v2-live-encrypted-snapshot"
    || value.status !== "pass"
    || value.authorizesV2Writes !== false
    || value.sourceStableDuringBackup !== true
    || value.restoreVerified !== true
    || value.restoredPlaintextRemoved !== true
    || value.snapshot?.integrity !== "ok"
    || value.snapshot?.foreignKeyViolations !== 0
    || !Number.isInteger(value.snapshot?.memoryTruthRows)
    || !/^[a-f0-9]{64}$/i.test(value.snapshot?.memoryTruthLogicalDigest ?? "")
    || !/^[a-f0-9]{64}$/i.test(value.archiveSha256 ?? "")
  ) throw new Error("snapshot receipt contract is invalid");
  return { value, sha256: hash(bytes) };
}

function verifyArchive(path: string, expectedSha256: string): void {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0) {
    throw new Error("encrypted snapshot archive must be a non-empty owner-only file");
  }
  if (hash(readFileSync(path)) !== expectedSha256) throw new Error("encrypted snapshot archive checksum mismatch");
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim().slice(0, 4096));
}

export function projectLegacySearchMetadataV1(value: string): string {
  const metadata = parseRecord(value);
  return PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1
    .flatMap((field) => strings(metadata[field]))
    .join("\n");
}

function scalar(db: DatabaseSync, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

export function buildLiveCompatibilityBackfillPlanV1(db: DatabaseSync): CompatibilityBackfillPlanEvidenceV1 {
  const sourceRows = scalar(db, "SELECT COUNT(*) FROM memory_truth");
  const v2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
  const projectionExists = Boolean(db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name='memory_fts_compat_v2'",
  ).get());
  const existingProjectionRows = projectionExists
    ? scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2")
    : 0;
  const missingV2 = scalar(db, `SELECT COUNT(*) FROM memory_truth l
    LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`);
  const missingV1 = scalar(db, `SELECT COUNT(*) FROM memory_items i
    LEFT JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
  const rows = db.prepare(`SELECT l.id,l.metadata,i.item_id,i.content
    FROM memory_truth l JOIN memory_items i ON i.item_id='legacy:' || l.id ORDER BY l.id`).all() as Array<{
      id: string;
      metadata: string;
      item_id: string;
      content: string;
    }>;
  const manifestDigest = hash(JSON.stringify(rows.map((row) => ({
    legacyIdSha256: hash(String(row.id)),
    itemIdSha256: hash(String(row.item_id)),
    contentSha256: hash(String(row.content)),
    projectedMetadataSha256: hash(projectLegacySearchMetadataV1(String(row.metadata || "{}"))),
  }))));
  const plan = {
    schemaVersion: 1 as const,
    phase: "clawlore-compatibility-backfill-plan" as const,
    readOnly: true as const,
    emitsMemoryContent: false as const,
    sourceUnchanged: true as const,
    sourceRows,
    v2Rows,
    existingProjectionRows,
    expectedProjectionRows: sourceRows,
    mappingMismatchRows: missingV1 + missingV2,
    rawLegacyMetadataCopied: false as const,
    indexedLegacyMetadataFields: [...PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1],
    planDigest: "",
    authorizesLiveMutation: false as const,
  };
  plan.planDigest = hash(JSON.stringify({ ...plan, planDigest: undefined, manifestDigest }));
  return plan;
}

function classification(value: unknown): LegacyCandidateClassificationV1 {
  return [
    "explicit_manual", "reflection_summary", "task_experience",
    "operational_checkpoint", "auto_capture", "unknown_legacy",
  ].includes(String(value)) ? value as LegacyCandidateClassificationV1 : "unknown_legacy";
}

function candidateReviewRow(row: LiveCandidateRow): CandidatePromotionReviewRowV1 {
  const address = JSON.parse(row.address_json) as MemoryAddressV2;
  const source = parseRecord(row.evidence_json);
  const kind = classification(source.classification);
  let attribution: CandidateAttributionEvidenceV1 = "none";
  const evidence: CandidatePromotionReviewRowV1["evidence"] = { sourceReceiptCount: 0 };
  if (kind === "unknown_legacy") {
    attribution = "opaque";
  } else if (address.visibility === "private" && address.principalId !== "legacy:unresolved") {
    attribution = "runtime_principal";
    evidence.identityEvidenceDigest = hash(JSON.stringify({
      principalId: address.principalId,
      platform: address.platform ?? "",
      accountId: address.accountId ?? "",
      legacySourceId: row.external_id ?? "",
    }));
    evidence.resolvedPrincipalId = address.principalId;
  }
  return {
    itemId: row.item_id,
    lifecycle: row.lifecycle as MemoryLifecycleV2,
    verification: row.verification as MemoryVerificationV2,
    classification: kind,
    attribution,
    address,
    evidence,
  };
}

function promotionPlan(db: DatabaseSync): ReturnType<typeof planCandidatePromotionsV1> {
  const rows = db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,i.address_json,
    COALESCE((SELECT s.evidence_json FROM memory_sources s
      WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json,
    (SELECT s.external_id FROM memory_sources s
      WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1) AS external_id
    FROM memory_items i
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as LiveCandidateRow[];
  return planCandidatePromotionsV1(rows.map(candidateReviewRow));
}

export async function createLivePhase7GPreviewV1(input: {
  sourcePath: string;
  snapshotArchivePath: string;
  snapshotReceiptPath: string;
  snapshotRestoreTestPath: string;
  compatibilityRolloutId: string;
  promotionRolloutId: string;
  now?: () => Date;
}): Promise<LivePhase7GPreviewReceiptV1> {
  const loaded = privateSnapshotReceipt(input.snapshotReceiptPath);
  verifyArchive(input.snapshotArchivePath, loaded.value.archiveSha256);
  const residueFiles = [
    input.snapshotRestoreTestPath,
    `${input.snapshotRestoreTestPath}-wal`,
    `${input.snapshotRestoreTestPath}-shm`,
  ].filter(existsSync).length;
  const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    before.memoryTruth.rowCount !== loaded.value.snapshot.memoryTruthRows
    || before.memoryTruth.logicalDigest !== loaded.value.snapshot.memoryTruthLogicalDigest
  ) throw new Error("fresh snapshot no longer matches live source truth");

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  let compatibility: CompatibilityBackfillPlanEvidenceV1;
  let promotion: ReturnType<typeof planCandidatePromotionsV1>;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    compatibility = buildLiveCompatibilityBackfillPlanV1(db);
    promotion = promotionPlan(db);
  } finally {
    db.close();
  }
  const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  const sourceUnchanged = before.schemaDigest === after.schemaDigest
    && before.memoryTruth.rowCount === after.memoryTruth.rowCount
    && before.memoryTruth.logicalDigest === after.memoryTruth.logicalDigest;
  if (!sourceUnchanged) throw new Error("live source truth changed during Phase 7G preview");
  const controls = buildPhase7GControlBundleV1({
    compatibilityRolloutId: input.compatibilityRolloutId,
    promotionRolloutId: input.promotionRolloutId,
    snapshot: {
      receiptSha256: loaded.sha256,
      createdAt: loaded.value.createdAt,
      sourceLogicalDigest: loaded.value.snapshot.memoryTruthLogicalDigest,
      sourceRows: loaded.value.snapshot.memoryTruthRows,
      candidateRows: promotion.rows.length,
      restoreVerified: loaded.value.restoreVerified,
      sourceUnchanged,
      plaintextResidueFiles: residueFiles,
    },
    compatibilityPlan: compatibility,
    promotionPlan: promotion,
    now: input.now,
  });
  return {
    schemaVersion: 1,
    phase: "clawlore-phase7g-live-preview",
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    readOnly: true,
    emitsMemoryContent: false,
    sourceUnchanged: true,
    snapshotReceiptSha256: loaded.sha256,
    compatibilityPlan: compatibility,
    candidatePromotionPlan: promotion,
    controls,
    liveMutation: {
      compatibilityProjectionCreated: false,
      lifecycleRowsChanged: 0,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}
