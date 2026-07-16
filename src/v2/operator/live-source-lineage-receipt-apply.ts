import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
import {
  createLiveSourceLineageReceiptPlanV1,
  type SourceLineageReceiptPlanV1,
} from "./live-source-lineage-receipt-plan.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;

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
    schemaDigest: string;
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

interface CandidateSourceRow {
  item_id: string;
  current_revision_id: string;
  address_json: string;
  lifecycle: string;
  verification: string;
  legacy_id: string;
  metadata: string;
  metadata_text: string;
  source_id: string;
  source_type: string;
  external_id: string | null;
  observed_at: string;
  evidence_json: string;
}

interface EventRow {
  event_id: string;
  item_id: string;
  revision_id: string;
  event_type: string;
  actor: string;
  reason: string;
  created_at: string;
}

export interface LiveSourceLineageReceiptApplyV1 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-source-lineage-receipt-apply";
  rolloutId: string;
  status: "applied";
  appliedAt: string;
  planDigest: string;
  planSha256: string;
  snapshotReceiptSha256: string;
  snapshotArchiveSha256: string;
  source: {
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    unchanged: true;
  };
  evidence: {
    rowsWritten: number;
    reflectionSummaryRows: number;
    operationalCheckpointRows: number;
    incompleteLineageRows: 0;
    nonTargetEvidenceRowsChanged: 0;
    eventRowsChanged: 0;
  };
  canonical: {
    memoryItemRowsChanged: 0;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
    addressRowsChanged: 0;
    projectionRowsChanged: 0;
    pendingOutboxRowsChanged: 0;
  };
  database: {
    integrity: "ok";
    foreignKeyViolations: 0;
  };
  runtime: {
    v1FallbackReads: true;
    lifecycleMutationEnabled: false;
    verificationMutationEnabled: false;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateBytes(path: string, maximumBytes = CONTROL_MAX_BYTES): { bytes: Buffer; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > maximumBytes) {
    throw new Error("rollout control must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  return { bytes, sha256: hash(bytes) };
}

function privateJson<T>(path: string, maximumBytes = CONTROL_MAX_BYTES): { value: T; sha256: string } {
  const loaded = privateBytes(path, maximumBytes);
  const value = JSON.parse(loaded.bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rollout control JSON is invalid");
  }
  return { value, sha256: loaded.sha256 };
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("existing source evidence is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("existing source evidence is not valid JSON");
  }
}

function planCore(plan: SourceLineageReceiptPlanV1): Record<string, unknown> {
  return {
    proposedRolloutId: plan.proposedRolloutId,
    remediationPlanDigest: plan.remediationPlanDigest,
    remediationPreviewSha256: plan.remediationPreviewSha256,
    source: plan.source,
    summary: plan.summary,
    classifications: plan.classifications,
    decisions: plan.decisions,
    rows: plan.rows,
  };
}

function loadPlan(path: string, rolloutId: string, digest: string): {
  value: SourceLineageReceiptPlanV1;
  sha256: string;
} {
  const loaded = privateJson<SourceLineageReceiptPlanV1>(path);
  const value = loaded.value;
  if (
    value.schemaVersion !== 1
    || value.phase !== "clawlore-source-lineage-receipt-plan"
    || value.proposedRolloutId !== rolloutId
    || value.planDigest !== digest
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.sourceLineageOnly !== true
    || value.authorizesEvidenceWrite !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesVerificationMutation !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
    || value.requiresFreshSnapshotBeforeApply !== true
    || hash(JSON.stringify(planCore(value))) !== value.planDigest
  ) throw new Error("source-lineage plan is invalid or digest-mismatched");
  const targets = value.rows.filter((row) => row.decision === "propose_source_lineage_receipt");
  if (
    value.summary.incompleteLineageRows !== 0
    || value.decisions.hold_incomplete_lineage !== 0
    || targets.length !== value.summary.proposedSourceLineageReceiptRows
    || targets.length !== value.summary.derivedSystemRows
    || targets.some((row) => !row.eventEvidenceDigest || !row.proposedReceiptPayloadDigest)
    || value.rows.some((row) => row.postLifecycle !== "candidate"
      || row.lifecycleMutationAllowed !== false
      || row.verificationMutationAllowed !== false)
  ) throw new Error("source-lineage target coverage is incomplete or mutation-unsafe");
  return loaded;
}

function loadFreshSnapshot(input: {
  receiptPath: string;
  archivePath: string;
  now: Date;
  maximumAgeSeconds: number;
}): { value: SnapshotReceiptV1; sha256: string } {
  const loaded = privateJson<SnapshotReceiptV1>(input.receiptPath, 128 * 1024);
  const value = loaded.value;
  const createdAt = Date.parse(value.createdAt);
  const ageSeconds = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((input.now.getTime() - createdAt) / 1000))
    : Number.POSITIVE_INFINITY;
  const archive = privateBytes(input.archivePath, 1024 * 1024 * 1024);
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
    || ageSeconds > input.maximumAgeSeconds
    || archive.sha256 !== value.archiveSha256
  ) throw new Error("fresh encrypted snapshot is invalid, stale, or checksum-mismatched");
  return loaded;
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function sourceState(db: DatabaseSync): SourceLineageReceiptPlanV1["source"] {
  return {
    v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
    v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
    candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    compatibilityRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2"),
    currentFtsRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
    vectorRows: scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2"),
    relationRows: scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2"),
    pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
  };
}

function stableStateDigest(row: CandidateSourceRow): string {
  return hash(JSON.stringify({
    itemId: row.item_id,
    currentRevisionId: row.current_revision_id,
    addressJson: row.address_json,
    lifecycle: row.lifecycle,
    verification: row.verification,
  }));
}

function sourceEvidence(row: CandidateSourceRow, evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    itemIdSha256: hash(row.item_id),
    revisionIdSha256: hash(row.current_revision_id),
    legacyIdSha256: hash(row.legacy_id),
    metadataSha256: hash(row.metadata),
    metadataTextSha256: hash(row.metadata_text),
    sourceIdSha256: hash(row.source_id),
    sourceType: row.source_type,
    externalIdMatchesLegacy: row.external_id === row.legacy_id,
    observedAt: row.observed_at,
    sourceEvidenceJsonSha256: hash(row.evidence_json),
    rolloutIdSha256: typeof evidence.rolloutId === "string" && evidence.rolloutId.trim()
      ? hash(evidence.rolloutId.trim())
      : null,
  };
}

function matchingEvent(row: CandidateSourceRow, evidence: Record<string, unknown>, events: EventRow[]): EventRow | undefined {
  const rolloutId = typeof evidence.rolloutId === "string" ? evidence.rolloutId.trim() : "";
  if (!rolloutId) return undefined;
  const matches = events.filter((event) => event.item_id === row.item_id
    && event.revision_id === row.current_revision_id
    && event.event_type === "remembered"
    && [
      "operator:approved-rollout",
      "operator:approved-delta-rollout",
      "operator:bounded-rollout",
      "operator:bounded-delta-rollout",
    ].includes(event.actor)
    && event.reason === rolloutId);
  return matches.length === 1 ? matches[0] : undefined;
}

function eventEvidence(event: EventRow): Record<string, unknown> {
  return {
    eventIdSha256: hash(event.event_id),
    itemIdSha256: hash(event.item_id),
    revisionIdSha256: hash(event.revision_id),
    eventType: event.event_type,
    actor: event.actor,
    reasonSha256: hash(event.reason),
    createdAt: event.created_at,
  };
}

function canonicalDigest(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT item_id,current_revision_id,address_json,lifecycle,verification
    FROM memory_items ORDER BY item_id`).all();
  return hash(JSON.stringify(rows));
}

function eventDigest(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT event_id,item_id,revision_id,event_type,actor,reason,created_at
    FROM memory_events ORDER BY event_id`).all();
  return hash(JSON.stringify(rows));
}

function sourceEvidenceRows(db: DatabaseSync): Array<{ source_id: string; evidence_json: string }> {
  return db.prepare("SELECT source_id,evidence_json FROM memory_sources ORDER BY source_id").all() as Array<{
    source_id: string;
    evidence_json: string;
  }>;
}

function evidenceDigest(rows: Array<{ source_id: string; evidence_json: string }>, exclude: Set<string>): string {
  return hash(JSON.stringify(rows.filter((row) => !exclude.has(row.source_id))));
}

export async function executeLiveSourceLineageReceiptApplyV1(input: {
  sourcePath: string;
  remediationPreviewPath: string;
  planPath: string;
  snapshotArchivePath: string;
  snapshotReceiptPath: string;
  rolloutId: string;
  planDigest: string;
  now?: () => Date;
  maximumSnapshotAgeSeconds?: number;
}): Promise<LiveSourceLineageReceiptApplyV1> {
  const appliedAtDate = input.now?.() ?? new Date();
  const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
    throw new Error("maximum snapshot age must be a positive integer");
  }
  const plan = loadPlan(input.planPath, input.rolloutId, input.planDigest);
  const snapshot = loadFreshSnapshot({
    receiptPath: input.snapshotReceiptPath,
    archivePath: input.snapshotArchivePath,
    now: appliedAtDate,
    maximumAgeSeconds,
  });
  const currentPlan = createLiveSourceLineageReceiptPlanV1({
    sourcePath: input.sourcePath,
    remediationPreviewPath: input.remediationPreviewPath,
    proposedRolloutId: input.rolloutId,
  });
  if (JSON.stringify(currentPlan) !== JSON.stringify(plan.value)) {
    throw new Error("live source lineage no longer matches the exact plan");
  }
  const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    legacyBefore.schemaDigest !== snapshot.value.snapshot.schemaDigest
    || legacyBefore.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
    || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest
  ) throw new Error("live truth no longer matches the fresh encrypted snapshot");

  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  const db = new DatabaseSync(input.sourcePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
  const targets = plan.value.rows.filter((row) => row.decision === "propose_source_lineage_receipt");
  const targetByItemHash = new Map(targets.map((row) => [row.itemIdSha256, row]));
  const beforeState = sourceState(db);
  const beforeCanonicalDigest = canonicalDigest(db);
  const beforeEventDigest = eventDigest(db);
  const beforeSources = sourceEvidenceRows(db);
  const targetSourceIds = new Set<string>();
  const expectedEvidence = new Map<string, string>();
  let reflectionSummaryRows = 0;
  let operationalCheckpointRows = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (JSON.stringify(sourceState(db)) !== JSON.stringify(plan.value.source)) {
      throw new Error("live source counts changed after exact-plan validation");
    }
    const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      l.id AS legacy_id,l.metadata,l.metadata_text,s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id,s.source_id`).all() as CandidateSourceRow[];
    if (candidates.length !== plan.value.source.candidateRows) {
      throw new Error("candidate source mapping must remain one row per candidate");
    }
    const events = db.prepare(`SELECT event_id,item_id,revision_id,event_type,actor,reason,created_at
      FROM memory_events WHERE event_type='remembered' ORDER BY event_id`).all() as EventRow[];
    const update = db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?");
    for (const row of candidates) {
      const target = targetByItemHash.get(hash(row.item_id));
      if (!target) continue;
      const existing = parseRecord(row.evidence_json);
      if ("sourceLineageReceiptV1" in existing) {
        throw new Error("target source-lineage receipt already exists");
      }
      const event = matchingEvent(row, existing, events);
      if (!event) throw new Error("target exact migration event is missing or ambiguous");
      const classification = String(existing.classification ?? "");
      if (classification !== target.classification) {
        throw new Error("target source classification changed after planning");
      }
      const sourceDigest = hash(JSON.stringify(sourceEvidence(row, existing)));
      const eventDigestValue = hash(JSON.stringify(eventEvidence(event)));
      const payload = {
        schemaVersion: 1,
        evidenceKind: "source-lineage-receipt",
        supportsSourceLineageOnly: true,
        authorizesLifecycleChange: false,
        authorizesVerificationChange: false,
        classification,
        sourceEvidenceDigest: sourceDigest,
        eventEvidenceDigest: eventDigestValue,
      };
      if (
        stableStateDigest(row) !== target.currentStateDigest
        || sourceDigest !== target.sourceEvidenceDigest
        || eventDigestValue !== target.eventEvidenceDigest
        || hash(JSON.stringify(payload)) !== target.proposedReceiptPayloadDigest
      ) throw new Error("target source-lineage evidence changed after planning");
      const receipt = {
        ...payload,
        rolloutId: input.rolloutId,
        planDigest: input.planDigest,
        proposedReceiptPayloadDigest: target.proposedReceiptPayloadDigest,
        recordedAt: appliedAtDate.toISOString(),
        preservesLifecycle: true,
        preservesVerification: true,
      };
      const updated = JSON.stringify({ ...existing, sourceLineageReceiptV1: receipt });
      const result = update.run(updated, row.source_id);
      if (Number(result.changes) !== 1) {
        throw new Error("source-lineage receipt did not update exactly one source row");
      }
      targetSourceIds.add(row.source_id);
      expectedEvidence.set(row.source_id, updated);
      if (classification === "reflection_summary") reflectionSummaryRows += 1;
      else operationalCheckpointRows += 1;
    }
    if (
      expectedEvidence.size !== targets.length
      || reflectionSummaryRows !== plan.value.classifications.reflection_summary
      || operationalCheckpointRows !== plan.value.classifications.operational_checkpoint
    ) throw new Error("applied source-lineage counts do not match the exact plan");

    const afterSourcesInTransaction = sourceEvidenceRows(db);
    const afterBySource = new Map(afterSourcesInTransaction.map((row) => [row.source_id, row.evidence_json]));
    if (
      afterSourcesInTransaction.length !== beforeSources.length
      || [...expectedEvidence].some(([sourceId, value]) => afterBySource.get(sourceId) !== value)
      || evidenceDigest(beforeSources, targetSourceIds) !== evidenceDigest(afterSourcesInTransaction, targetSourceIds)
      || JSON.stringify(sourceState(db)) !== JSON.stringify(beforeState)
      || canonicalDigest(db) !== beforeCanonicalDigest
      || eventDigest(db) !== beforeEventDigest
    ) throw new Error("transaction exceeded the source-lineage evidence-only boundary");
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) {
      throw new Error("database verification failed before commit");
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    db.close();
    throw error;
  }

  const afterSources = sourceEvidenceRows(db);
  const afterBySource = new Map(afterSources.map((row) => [row.source_id, row.evidence_json]));
  const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
  const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  const postCommitVerified = integrity === "ok"
    && foreignKeyViolations === 0
    && JSON.stringify(sourceState(db)) === JSON.stringify(beforeState)
    && canonicalDigest(db) === beforeCanonicalDigest
    && eventDigest(db) === beforeEventDigest
    && evidenceDigest(beforeSources, targetSourceIds) === evidenceDigest(afterSources, targetSourceIds)
    && [...expectedEvidence].every(([sourceId, value]) => afterBySource.get(sourceId) === value);
  db.close();
  const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    !postCommitVerified
    || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
    || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest
  ) throw new Error("post-commit source-lineage verification failed");

  return {
    schemaVersion: 1,
    phase: "clawlore-v2-live-source-lineage-receipt-apply",
    rolloutId: input.rolloutId,
    status: "applied",
    appliedAt: appliedAtDate.toISOString(),
    planDigest: input.planDigest,
    planSha256: plan.sha256,
    snapshotReceiptSha256: snapshot.sha256,
    snapshotArchiveSha256: snapshot.value.archiveSha256,
    source: {
      memoryTruthRows: legacyAfter.memoryTruth.rowCount,
      memoryTruthLogicalDigest: legacyAfter.memoryTruth.logicalDigest,
      unchanged: true,
    },
    evidence: {
      rowsWritten: targets.length,
      reflectionSummaryRows,
      operationalCheckpointRows,
      incompleteLineageRows: 0,
      nonTargetEvidenceRowsChanged: 0,
      eventRowsChanged: 0,
    },
    canonical: {
      memoryItemRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      projectionRowsChanged: 0,
      pendingOutboxRowsChanged: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
    runtime: {
      v1FallbackReads: true,
      lifecycleMutationEnabled: false,
      verificationMutationEnabled: false,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}
