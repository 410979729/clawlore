import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { buildLegacyMigrationBatchV2 } from "../migration/legacy-v2-migration.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

interface PostAssignmentBaselineV1 {
  schemaVersion: 1;
  phase: "clawlore-post-assignment-candidate-plan";
  proposedRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  assignment: { rowsValidated: number; invalidEvidenceRows: 0; unplannedEvidenceRows: 0 };
  source: {
    v1Rows: number;
    v2Rows: number;
    candidateRows: number;
    activeRows: number;
    archivedRows: number;
    compatibilityRows: number;
    pendingOutboxRows: number;
    baselineV1Rows: number;
    unmirroredV1Rows: number;
    missingLegacyRowsForV2: 0;
    candidateBaselineUnchanged: true;
    sourceUnchangedDuringPlan: true;
  };
  candidatePromotionPlan: {
    planDigest: string;
    automaticPromotionRows: 0;
    authorizesLiveMutation: false;
    counts: {
      eligible_for_promotion?: number;
      eligible_for_operator_promotion?: number;
      hold_candidate: number;
      quarantine: number;
    };
  };
  decision: { eligibleRows: number; lifecycleRolloutSelectable: false; automaticPromotionRows: 0 };
  authorizesLifecycleMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  liveMutation: {
    evidenceRowsChanged: 0;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
    addressRowsChanged: 0;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

export interface LiveV1AppendDeltaPlanReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-v1-append-delta-plan";
  createdAt: string;
  proposedRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsRawIdentifiers: false;
  baseline: {
    receiptSha256: string;
    candidatePlanDigest: string;
    candidateRows: number;
    candidateBaselineUnchanged: true;
  };
  source: {
    v1Rows: number;
    v2Rows: number;
    deltaRows: number;
    missingLegacyRowsForV2: 0;
    compatibilityRows: number;
    pendingOutboxRows: number;
    memoryTruthLogicalDigest: string;
    sourceUnchangedDuringPlan: true;
  };
  proposed: {
    activeRows: number;
    candidateRows: number;
    archivedRows: number;
    classifications: Record<string, number>;
    verifications: Record<string, number>;
    verificationDebt: Record<string, number>;
    reviewRequiredRows: number;
    invalidMetadataRows: number;
    rows: Array<{
      legacyIdSha256: string;
      contentSha256: string;
      addressSha256: string;
      classification: string;
      lifecycle: string;
      verification: string;
      reviewRequired: boolean;
      verificationDebt: string;
    }>;
    planDigest: string;
  };
  projectionWork: {
    truthRows: number;
    compatibilityRows: number;
    ftsRows: number;
    vectorRows: number;
    relationProjectionRows: number;
    outboxRows: number;
  };
  decision: {
    deltaWriteReady: boolean;
    requiresFreshEncryptedSnapshot: true;
    finalRecallCutoverReady: false;
  };
  authorizesDeltaWrite: false;
  authorizesLifecyclePromotion: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  liveMutation: {
    v2RowsChanged: 0;
    projectionRowsChanged: 0;
    lifecycleRowsChanged: 0;
    configurationChanged: false;
    serviceRestarted: false;
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateBaseline(path: string): { value: PostAssignmentBaselineV1; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("delta-plan baseline must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as PostAssignmentBaselineV1;
  const eligibleRows = value.candidatePromotionPlan?.counts?.eligible_for_promotion
    ?? value.candidatePromotionPlan?.counts?.eligible_for_operator_promotion;
  if (
    value.schemaVersion !== 1
    || value.phase !== "clawlore-post-assignment-candidate-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.assignment.rowsValidated <= 0
    || value.assignment.invalidEvidenceRows !== 0
    || value.assignment.unplannedEvidenceRows !== 0
    || value.source.candidateBaselineUnchanged !== true
    || value.source.sourceUnchangedDuringPlan !== true
    || value.source.missingLegacyRowsForV2 !== 0
    || !hasDigest(value.candidatePromotionPlan.planDigest)
    || value.candidatePromotionPlan.automaticPromotionRows !== 0
    || value.candidatePromotionPlan.authorizesLiveMutation !== false
    || eligibleRows !== 0
    || value.decision.eligibleRows !== 0
    || value.decision.lifecycleRolloutSelectable !== false
    || value.decision.automaticPromotionRows !== 0
    || value.authorizesLifecycleMutation !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
    || value.liveMutation.evidenceRowsChanged !== 0
    || value.liveMutation.lifecycleRowsChanged !== 0
    || value.liveMutation.verificationRowsChanged !== 0
    || value.liveMutation.addressRowsChanged !== 0
    || value.liveMutation.contextEngineEnabled !== false
    || value.liveMutation.promptMutationEnabled !== false
    || value.liveMutation.finalRecallCutoverEnabled !== false
  ) throw new Error("post-assignment candidate baseline contract is invalid");
  return { value, sha256: hash(bytes) };
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function invalidMetadataRows(db: DatabaseSync, deltaIds: Set<string>): number {
  const rows = db.prepare(`SELECT id,metadata FROM memory_truth ORDER BY id`).all() as Array<{
    id: string;
    metadata: string;
  }>;
  let invalid = 0;
  for (const row of rows) {
    if (!deltaIds.has(String(row.id))) continue;
    try {
      const value = JSON.parse(String(row.metadata || "{}"));
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return invalid;
}

export async function createLiveV1AppendDeltaPlanV1(input: {
  sourcePath: string;
  baselineReceiptPath: string;
  proposedRolloutId: string;
  defaults: { tenantId: string; agentId: string; workspaceId?: string };
  now?: () => Date;
}): Promise<LiveV1AppendDeltaPlanReceiptV1> {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
    throw new Error("proposed delta rollout id is invalid");
  }
  const baseline = privateBaseline(input.baselineReceiptPath);
  const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  const migration = buildLegacyMigrationBatchV2({ legacyPath: input.sourcePath, defaults: input.defaults });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
  let v2Rows = 0;
  let compatibilityRows = 0;
  let pendingOutboxRows = 0;
  let missingLegacyRowsForV2 = 0;
  let deltaIds = new Set<string>();
  let invalidMetadata = 0;
  try {
    v2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
    compatibilityRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
    pendingOutboxRows = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
    const candidateRows = scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'");
    const activeRows = scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'");
    const archivedRows = scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'");
    missingLegacyRowsForV2 = scalar(db, `SELECT COUNT(*) FROM memory_items i
      LEFT JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
    deltaIds = new Set((db.prepare(`SELECT l.id FROM memory_truth l LEFT JOIN memory_items i
      ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL ORDER BY l.id`).all() as Array<{ id: string }>)
      .map((row) => String(row.id)));
    invalidMetadata = invalidMetadataRows(db, deltaIds);
    if (
      before.memoryTruth.rowCount < baseline.value.source.v1Rows
      || v2Rows !== baseline.value.source.v2Rows
      || candidateRows !== baseline.value.source.candidateRows
      || activeRows !== baseline.value.source.activeRows
      || archivedRows !== baseline.value.source.archivedRows
      || compatibilityRows !== baseline.value.source.compatibilityRows
      || pendingOutboxRows !== baseline.value.source.pendingOutboxRows
      || missingLegacyRowsForV2 !== 0
      || deltaIds.size !== before.memoryTruth.rowCount - v2Rows
    ) throw new Error("live V1/V2 delta no longer matches the post-assignment baseline");
  } finally {
    db.close();
  }
  const delta = migration.rows.filter((row) => deltaIds.has(row.legacyId));
  if (delta.length !== deltaIds.size || migration.plan.totalRows !== before.memoryTruth.rowCount) {
    throw new Error("append-only V1 delta mapping is incomplete");
  }
  const rows = delta.map((row) => ({
    legacyIdSha256: hash(row.legacyId),
    contentSha256: hash(row.content),
    addressSha256: hash(JSON.stringify(row.address)),
    classification: row.classification,
    lifecycle: row.lifecycle,
    verification: row.verification,
    reviewRequired: row.reviewRequired,
    verificationDebt: row.verificationDebt,
  }));
  const classifications: Record<string, number> = {};
  const verifications: Record<string, number> = {};
  const verificationDebt: Record<string, number> = {};
  for (const row of rows) {
    increment(classifications, row.classification);
    increment(verifications, row.verification);
    increment(verificationDebt, row.verificationDebt);
  }
  const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    after.schemaDigest !== before.schemaDigest
    || after.memoryTruth.rowCount !== before.memoryTruth.rowCount
    || after.memoryTruth.logicalDigest !== before.memoryTruth.logicalDigest
  ) throw new Error("live V1 source changed during append-delta planning");
  const deltaRows = rows.length;
  return {
    schemaVersion: 1,
    phase: "clawlore-v1-append-delta-plan",
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    proposedRolloutId: input.proposedRolloutId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsRawIdentifiers: false,
    baseline: {
      receiptSha256: baseline.sha256,
      candidatePlanDigest: baseline.value.candidatePromotionPlan.planDigest,
      candidateRows: baseline.value.source.candidateRows,
      candidateBaselineUnchanged: true,
    },
    source: {
      v1Rows: before.memoryTruth.rowCount,
      v2Rows,
      deltaRows,
      missingLegacyRowsForV2: 0,
      compatibilityRows,
      pendingOutboxRows,
      memoryTruthLogicalDigest: before.memoryTruth.logicalDigest,
      sourceUnchangedDuringPlan: true,
    },
    proposed: {
      activeRows: rows.filter((row) => row.lifecycle === "active").length,
      candidateRows: rows.filter((row) => row.lifecycle === "candidate").length,
      archivedRows: rows.filter((row) => row.lifecycle === "archived").length,
      classifications,
      verifications,
      verificationDebt,
      reviewRequiredRows: rows.filter((row) => row.reviewRequired).length,
      invalidMetadataRows: invalidMetadata,
      rows,
      planDigest: hash(JSON.stringify(rows)),
    },
    projectionWork: {
      truthRows: deltaRows,
      compatibilityRows: deltaRows,
      ftsRows: deltaRows,
      vectorRows: deltaRows,
      relationProjectionRows: deltaRows,
      outboxRows: deltaRows * 3,
    },
    decision: {
      deltaWriteReady: deltaRows > 0 && invalidMetadata === 0,
      requiresFreshEncryptedSnapshot: true,
      finalRecallCutoverReady: false,
    },
    authorizesDeltaWrite: false,
    authorizesLifecyclePromotion: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    liveMutation: {
      v2RowsChanged: 0,
      projectionRowsChanged: 0,
      lifecycleRowsChanged: 0,
      configurationChanged: false,
      serviceRestarted: false,
    },
  };
}
