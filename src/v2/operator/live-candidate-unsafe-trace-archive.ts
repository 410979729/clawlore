import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";
import {
  validateLiveCandidateUnsafeTraceDispositionPlanV1,
  type LiveCandidateUnsafeTraceDispositionPlanV1,
} from "./live-candidate-unsafe-trace-disposition.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const TARGET_ROWS = 99;
const PROTECTED_REWRITE_ROWS = 32;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;

type ArchiveTargetV1 = LiveCandidateUnsafeTraceDispositionPlanV1["archiveRows"][number];
type RewriteHoldV1 = LiveCandidateUnsafeTraceDispositionPlanV1["rewriteDesigns"][number];
type DispositionRowV1 = ArchiveTargetV1 | RewriteHoldV1;

interface CandidateRowV1 {
  item_id: string;
  current_revision_id: string;
  revision_no: number;
  content: string;
  category: string;
  address_json: string;
  lifecycle: "candidate" | "archived";
  verification: "unverified";
  valid_until: string | null;
  metadata: string;
  source_id: string;
  source_type: string;
  external_id: string | null;
  observed_at: string;
  evidence_json: string;
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
    schemaDigest: string;
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

export interface LiveCandidateUnsafeTraceArchiveAcceptanceV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-soft-archive-acceptance";
  acceptedAt: string;
  status: "pass";
  planDigest: string;
  planSha256: string;
  source: CompanionDispositionSourceV1;
  summary: {
    archiveRows: 99;
    protectedRewriteRows: 32;
    liveBindingMismatches: 0;
    targetOverlapRows: 0;
  };
  protectedRewriteRowsDigest: string;
  rawTraceOrIdentifierLeak: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresFreshEncryptedSnapshot: true;
  requiresSeparateExactApply: true;
}

export interface LiveCandidateUnsafeTraceArchiveReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-soft-archive-live-apply";
  rolloutId: string;
  status: "applied";
  appliedAt: string;
  planDigest: string;
  planSha256: string;
  acceptanceSha256: string;
  snapshotReceiptSha256: string;
  snapshotArchiveSha256: string;
  sourceBefore: CompanionDispositionSourceV1;
  sourceAfter: CompanionDispositionSourceV1;
  archive: {
    targetRows: 99;
    candidateRowsArchived: 99;
    protectedRewriteRows: 32;
    protectedRewriteRowsChanged: 0;
    newArchivedRevisionRows: 99;
    oldRevisionRowsSuperseded: 99;
    newSourceRows: 99;
    newRelationRows: 99;
    newEventRows: 99;
    currentContentRowsChanged: 0;
    currentVerificationRowsChanged: 0;
    addressRowsChanged: 0;
    aclRowsChanged: 0;
    nonTargetRowsChanged: 0;
  };
  projections: {
    compatibilityRowsChanged: 0;
    currentFtsRowsChanged: 0;
    vectorRowsChanged: 0;
    relationProjectionRowsChanged: 0;
    pendingOutboxRowsChanged: 0;
  };
  database: { integrity: "ok"; foreignKeyViolations: 0 };
  runtime: {
    v1FallbackReads: true;
    existingCandidateLifecycleMutationEnabled: false;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

export interface LiveCandidateUnsafeTraceArchivePostcheckV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-soft-archive-postcheck";
  verifiedAt: string;
  status: "pass";
  rolloutId: string;
  planDigest: string;
  planSha256: string;
  applyReceiptSha256: string;
  source: CompanionDispositionSourceV1;
  targetBinding: {
    archivedRows: 99;
    protectedRewriteRows: 32;
    protectedRewriteRowsChanged: 0;
    validDispositionReceiptRows: 99;
    supersedesRelationRows: 99;
    archivedEventRows: 99;
    projectionBindingRows: 99;
    mismatches: 0;
  };
  database: { integrity: "ok"; foreignKeyViolations: 0 };
  runtime: LiveCandidateUnsafeTraceArchiveReceiptV1["runtime"];
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateBytes(path: string, maximumBytes: number): { bytes: Buffer; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > maximumBytes) {
    throw new Error("unsafe trace archive control must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  return { bytes, sha256: hash(bytes) };
}

function privateJson<T>(path: string, maximumBytes = CONTROL_MAX_BYTES): { value: T; sha256: string } {
  const loaded = privateBytes(path, maximumBytes);
  const value = JSON.parse(loaded.bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unsafe trace archive control JSON is invalid");
  }
  return { value, sha256: loaded.sha256 };
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function scalar(db: DatabaseSync, sql: string, ...args: unknown[]): number {
  return Number(Object.values(db.prepare(sql).get(...args) as Record<string, unknown>)[0] ?? 0);
}

function classification(metadata: Record<string, unknown>, evidence: Record<string, unknown>): string {
  const explicit = String(evidence.classification ?? "").trim();
  if (explicit) return explicit;
  const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
  if (source.includes("manual") || source.includes("user")) return "explicit_manual";
  if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) return "reflection_summary";
  if (source.includes("task") && source.includes("experience")) return "task_experience";
  if (source.includes("checkpoint") || source.includes("pressure")) return "operational_checkpoint";
  if (source.includes("capture")) return "auto_capture";
  return "unknown_legacy";
}

function candidateRows(db: DatabaseSync, lifecycle: "candidate" | "archived" = "candidate"): CandidateRowV1[] {
  return db.prepare(`SELECT i.item_id,i.current_revision_id,i.revision_no,i.content,i.category,
    i.address_json,i.lifecycle,i.verification,i.valid_until,l.metadata,
    s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle=? ORDER BY i.item_id`).all(lifecycle) as CandidateRowV1[];
}

function assertLiveRowMatches(row: CandidateRowV1, planned: DispositionRowV1): void {
  const metadata = parseRecord(row.metadata);
  const evidence = parseRecord(row.evidence_json);
  const lineage = evidence.sourceLineageReceiptV1;
  const safety = evaluateCaptureSafety(row.content);
  if (
    row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
    || safety.allowed !== false
    || safety.reason !== "operational-trace"
    || safety.pattern !== planned.captureSafetyPattern
    || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
    || hash(JSON.stringify(lineage)) !== planned.sourceLineageReceiptDigest
  ) throw new Error("unsafe trace archive live target no longer matches the exact disposition plan");
}

function validateCurrentBindings(input: {
  db: DatabaseSync;
  plan: LiveCandidateUnsafeTraceDispositionPlanV1;
}): Map<string, CandidateRowV1> {
  const source = companionDispositionSourceStateV1(input.db);
  if (!sameCompanionDispositionSourceV1(source, input.plan.source)) {
    throw new Error("live source no longer matches the unsafe trace disposition plan");
  }
  const candidates = candidateRows(input.db);
  if (candidates.length !== source.candidateRows) throw new Error("unsafe trace archive candidate mapping is incomplete");
  const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
  for (const planned of [...input.plan.archiveRows, ...input.plan.rewriteDesigns]) {
    const live = byHash.get(planned.itemIdSha256);
    if (!live) throw new Error("unsafe trace archive exact lane mapping is incomplete");
    assertLiveRowMatches(live, planned);
  }
  return byHash;
}

function protectedRewriteRowsDigest(plan: LiveCandidateUnsafeTraceDispositionPlanV1): string {
  return hash(JSON.stringify(plan.rewriteDesigns));
}

export function acceptLiveCandidateUnsafeTraceArchiveV1(input: {
  sourcePath: string;
  planPath: string;
  planDigest: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceArchiveAcceptanceV1 {
  const loaded = privateJson<LiveCandidateUnsafeTraceDispositionPlanV1>(input.planPath);
  const plan = validateLiveCandidateUnsafeTraceDispositionPlanV1(loaded.value, input.planDigest);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    validateCurrentBindings({ db, plan });
    if (!sameCompanionDispositionSourceV1(plan.source, companionDispositionSourceStateV1(db))) {
      throw new Error("live source changed during unsafe trace archive acceptance");
    }
  } finally {
    db.close();
  }
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-soft-archive-acceptance",
    acceptedAt: (input.now ?? (() => new Date()))().toISOString(),
    status: "pass",
    planDigest: plan.planDigest,
    planSha256: loaded.sha256,
    source: plan.source,
    summary: {
      archiveRows: TARGET_ROWS,
      protectedRewriteRows: PROTECTED_REWRITE_ROWS,
      liveBindingMismatches: 0,
      targetOverlapRows: 0,
    },
    protectedRewriteRowsDigest: protectedRewriteRowsDigest(plan),
    rawTraceOrIdentifierLeak: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresFreshEncryptedSnapshot: true,
    requiresSeparateExactApply: true,
  };
}

function validateAcceptance(
  value: LiveCandidateUnsafeTraceArchiveAcceptanceV1,
  plan: LiveCandidateUnsafeTraceDispositionPlanV1,
  planSha256: string,
): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-soft-archive-acceptance"
    || value.status !== "pass"
    || value.planDigest !== plan.planDigest
    || value.planSha256 !== planSha256
    || !sameCompanionDispositionSourceV1(value.source, plan.source)
    || value.summary?.archiveRows !== TARGET_ROWS
    || value.summary.protectedRewriteRows !== PROTECTED_REWRITE_ROWS
    || value.summary.liveBindingMismatches !== 0
    || value.summary.targetOverlapRows !== 0
    || value.protectedRewriteRowsDigest !== protectedRewriteRowsDigest(plan)
    || value.rawTraceOrIdentifierLeak !== false
    || value.authorizesContentRewrite !== false
    || value.authorizesSoftArchive !== false
    || value.authorizesHardDelete !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesVerificationMutation !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
    || value.requiresFreshEncryptedSnapshot !== true
    || value.requiresSeparateExactApply !== true
  ) throw new Error("unsafe trace archive acceptance is invalid or unbound");
}

function validateFreshSnapshot(input: {
  receiptPath: string;
  archivePath: string;
  now: Date;
  maximumAgeSeconds: number;
}): { value: SnapshotReceiptV1; sha256: string; archiveSha256: string } {
  const receipt = privateJson<SnapshotReceiptV1>(input.receiptPath, 128 * 1024);
  const archive = privateBytes(input.archivePath, 1024 * 1024 * 1024);
  const createdAt = Date.parse(receipt.value.createdAt);
  const ageSeconds = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((input.now.getTime() - createdAt) / 1000))
    : Number.POSITIVE_INFINITY;
  if (
    receipt.value.schemaVersion !== 1
    || receipt.value.phase !== "clawlore-v2-live-encrypted-snapshot"
    || receipt.value.status !== "pass"
    || receipt.value.authorizesV2Writes !== false
    || receipt.value.sourceStableDuringBackup !== true
    || receipt.value.restoreVerified !== true
    || receipt.value.restoredPlaintextRemoved !== true
    || receipt.value.snapshot.integrity !== "ok"
    || receipt.value.snapshot.foreignKeyViolations !== 0
    || archive.sha256 !== receipt.value.archiveSha256
    || ageSeconds > input.maximumAgeSeconds
  ) throw new Error("fresh encrypted snapshot is invalid, stale, or checksum-mismatched");
  return { value: receipt.value, sha256: receipt.sha256, archiveSha256: archive.sha256 };
}

function digestQuery(db: DatabaseSync, sql: string, args: unknown[] = []): string {
  return hash(JSON.stringify(db.prepare(sql).all(...args)));
}

function nonTargetDigest(db: DatabaseSync, targetItemIds: string[]): string {
  const placeholders = targetItemIds.map(() => "?").join(",");
  return hash(JSON.stringify([
    digestQuery(db, `SELECT * FROM memory_items WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_revisions WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,revision_no`, targetItemIds),
    digestQuery(db, `SELECT s.* FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
      WHERE r.item_id NOT IN (${placeholders}) ORDER BY r.item_id,s.source_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_acl WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,acl_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_events WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,event_id`, targetItemIds),
    digestQuery(db, `SELECT rel.* FROM memory_relations rel
      JOIN memory_revisions fr ON fr.revision_id=rel.from_revision_id
      JOIN memory_revisions tr ON tr.revision_id=rel.to_revision_id
      WHERE fr.item_id NOT IN (${placeholders}) AND tr.item_id NOT IN (${placeholders})
      ORDER BY rel.relation_id`, [...targetItemIds, ...targetItemIds]),
    digestQuery(db, `SELECT * FROM memory_fts_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_fts_compat_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_vector_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
    digestQuery(db, `SELECT * FROM memory_relation_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
    digestQuery(db, "SELECT * FROM projection_outbox ORDER BY outbox_id"),
  ]));
}

function targetProtectedDigest(db: DatabaseSync, targetItemIds: string[]): string {
  const placeholders = targetItemIds.map(() => "?").join(",");
  return hash(JSON.stringify([
    db.prepare(`SELECT item_id,content,category,address_json,tenant_id,principal_id,agent_id,visibility,retention,
      workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,verification,valid_until,created_at
      FROM memory_items WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
    db.prepare(`SELECT l.* FROM memory_truth l JOIN memory_items i ON i.item_id='legacy:' || l.id
      WHERE i.item_id IN (${placeholders}) ORDER BY l.id`).all(...targetItemIds),
    db.prepare(`SELECT * FROM memory_acl WHERE item_id IN (${placeholders}) ORDER BY item_id,acl_id`).all(...targetItemIds),
    db.prepare(`SELECT * FROM memory_fts_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
    db.prepare(`SELECT * FROM memory_fts_compat_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
    db.prepare(`SELECT * FROM memory_vector_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
    db.prepare(`SELECT * FROM memory_relation_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
  ]));
}

function expectedAfter(before: CompanionDispositionSourceV1): CompanionDispositionSourceV1 {
  return { ...before, candidateRows: before.candidateRows - TARGET_ROWS, archivedRows: before.archivedRows + TARGET_ROWS };
}

export async function executeLiveCandidateUnsafeTraceArchiveV1(input: {
  sourcePath: string;
  planPath: string;
  acceptancePath: string;
  snapshotArchivePath: string;
  snapshotReceiptPath: string;
  rolloutId: string;
  planDigest: string;
  now?: () => Date;
  maximumSnapshotAgeSeconds?: number;
}): Promise<LiveCandidateUnsafeTraceArchiveReceiptV1> {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId)) throw new Error("unsafe trace archive rollout id is invalid");
  const appliedAtDate = input.now?.() ?? new Date();
  const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
    throw new Error("maximum snapshot age must be a positive integer");
  }
  const loadedPlan = privateJson<LiveCandidateUnsafeTraceDispositionPlanV1>(input.planPath);
  const plan = validateLiveCandidateUnsafeTraceDispositionPlanV1(loadedPlan.value, input.planDigest);
  const loadedAcceptance = privateJson<LiveCandidateUnsafeTraceArchiveAcceptanceV1>(input.acceptancePath);
  validateAcceptance(loadedAcceptance.value, plan, loadedPlan.sha256);
  const snapshot = validateFreshSnapshot({
    receiptPath: input.snapshotReceiptPath,
    archivePath: input.snapshotArchivePath,
    now: appliedAtDate,
    maximumAgeSeconds,
  });
  const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    legacyBefore.schemaDigest !== snapshot.value.snapshot.schemaDigest
    || legacyBefore.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
    || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest
  ) throw new Error("live V1 truth no longer matches the fresh encrypted snapshot");
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  const db = new DatabaseSync(input.sourcePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
  const beforeSource = companionDispositionSourceStateV1(db);
  if (!sameCompanionDispositionSourceV1(beforeSource, plan.source)) {
    db.close();
    throw new Error("live source no longer matches the unsafe trace archive plan");
  }
  const byHash = validateCurrentBindings({ db, plan });
  const targetItemIds = plan.archiveRows.map((planned) => byHash.get(planned.itemIdSha256)!.item_id).sort();
  const protectedRewriteItemIds = plan.rewriteDesigns.map((planned) => byHash.get(planned.itemIdSha256)!.item_id).sort();
  if (new Set([...targetItemIds, ...protectedRewriteItemIds]).size !== TARGET_ROWS + PROTECTED_REWRITE_ROWS) {
    db.close();
    throw new Error("unsafe trace archive and rewrite hold lanes overlap");
  }
  const beforeNonTargetDigest = nonTargetDigest(db, targetItemIds);
  const beforeProtectedDigest = targetProtectedDigest(db, targetItemIds);
  const beforeCounts = {
    revisions: scalar(db, "SELECT COUNT(*) FROM memory_revisions"),
    sources: scalar(db, "SELECT COUNT(*) FROM memory_sources"),
    relations: scalar(db, "SELECT COUNT(*) FROM memory_relations"),
    events: scalar(db, "SELECT COUNT(*) FROM memory_events"),
    outbox: scalar(db, "SELECT COUNT(*) FROM projection_outbox"),
    rollouts: scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2"),
  };
  const appliedAt = appliedAtDate.toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    if (!sameCompanionDispositionSourceV1(companionDispositionSourceStateV1(db), beforeSource)) {
      throw new Error("live source drifted before unsafe trace archive transaction");
    }
    const transactionCandidates = new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
    for (const planned of [...plan.archiveRows, ...plan.rewriteDesigns]) {
      const live = transactionCandidates.get(planned.itemIdSha256);
      if (!live) throw new Error("unsafe trace disposition row disappeared before transaction");
      assertLiveRowMatches(live, planned);
    }
    for (const planned of plan.archiveRows) {
      const live = transactionCandidates.get(planned.itemIdSha256)!;
      const revisionId = randomUUID();
      const oldEvidence = parseRecord(live.evidence_json);
      const evidence = {
        ...oldEvidence,
        unsafeTraceDispositionReceiptV1: {
          schemaVersion: 1,
          rolloutId: input.rolloutId,
          planDigest: plan.planDigest,
          archivedFromRevisionIdSha256: planned.currentRevisionIdSha256,
          normalizedContentDigest: planned.normalizedContentDigest,
          archivedContentDigest: planned.contentDigest,
          sourceLineageReceiptDigest: planned.sourceLineageReceiptDigest,
          captureSafetyPattern: planned.captureSafetyPattern,
          captureSafetyLane: planned.captureSafetyLane,
          reason: planned.reason,
          resultDigest: planned.resultDigest,
          appliedAt,
          preservesContent: true,
          preservesVerification: true,
          preservesAddress: true,
          preservesProjections: true,
          excludesRewriteHoldLane: true,
        },
      };
      const superseded = db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=? AND lifecycle='candidate'")
        .run(live.current_revision_id);
      if (Number(superseded.changes) !== 1) throw new Error("unsafe trace archive current revision supersession failed closed");
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        revisionId, live.item_id, Number(live.revision_no) + 1, live.content,
        "archived", "unverified", live.valid_until, appliedAt,
      );
      db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(
        randomUUID(), revisionId, live.source_type, live.external_id, live.observed_at, JSON.stringify(evidence),
      );
      db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(randomUUID(), revisionId, live.current_revision_id, "supersedes", appliedAt);
      db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        randomUUID(), live.item_id, revisionId, "archived", "operator:bounded-unsafe-trace-disposition", input.rolloutId, appliedAt,
      );
      const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,lifecycle='archived',updated_at=?
        WHERE item_id=? AND lifecycle='candidate' AND verification='unverified'`).run(
        revisionId, Number(live.revision_no) + 1, appliedAt, live.item_id,
      );
      if (Number(current.changes) !== 1) throw new Error("unsafe trace archive current item update failed closed");
    }
    db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(
      input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256,
      legacyBefore.memoryTruth.logicalDigest, TARGET_ROWS, appliedAt,
    );
    const after = companionDispositionSourceStateV1(db);
    if (
      !sameCompanionDispositionSourceV1(after, expectedAfter(beforeSource))
      || nonTargetDigest(db, targetItemIds) !== beforeNonTargetDigest
      || targetProtectedDigest(db, targetItemIds) !== beforeProtectedDigest
      || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + TARGET_ROWS
      || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + TARGET_ROWS
      || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + TARGET_ROWS
      || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + TARGET_ROWS
      || scalar(db, "SELECT COUNT(*) FROM projection_outbox") !== beforeCounts.outbox
      || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1
    ) throw new Error("unsafe trace archive transaction exceeded the exact ninety-nine-row boundary");
    const archived = targetItemIds.map((itemId) => db.prepare(`SELECT i.lifecycle,i.verification,i.content,
      r.lifecycle AS revision_lifecycle,r.verification AS revision_verification,s.evidence_json
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id WHERE i.item_id=?`).get(itemId)) as
      Array<Record<string, unknown>>;
    if (archived.some((row) => {
      const evidence = parseRecord(String(row.evidence_json));
      const receipt = evidence.unsafeTraceDispositionReceiptV1 as Record<string, unknown> | undefined;
      return row.lifecycle !== "archived"
        || row.verification !== "unverified"
        || row.revision_lifecycle !== "archived"
        || row.revision_verification !== "unverified"
        || receipt?.planDigest !== plan.planDigest
        || receipt.preservesContent !== true
        || receipt.preservesProjections !== true
        || receipt.excludesRewriteHoldLane !== true;
    })) throw new Error("unsafe trace archive current revision acceptance failed");
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) throw new Error("unsafe trace archive database integrity failed");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not be open */ }
    db.close();
    throw error;
  }
  const afterSource = companionDispositionSourceStateV1(db);
  const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
  const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  db.close();
  const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    !sameCompanionDispositionSourceV1(afterSource, expectedAfter(beforeSource))
    || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
    || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest
    || integrity !== "ok"
    || foreignKeyViolations !== 0
  ) throw new Error("unsafe trace archive post-commit acceptance failed");
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-soft-archive-live-apply",
    rolloutId: input.rolloutId,
    status: "applied",
    appliedAt,
    planDigest: plan.planDigest,
    planSha256: loadedPlan.sha256,
    acceptanceSha256: loadedAcceptance.sha256,
    snapshotReceiptSha256: snapshot.sha256,
    snapshotArchiveSha256: snapshot.archiveSha256,
    sourceBefore: beforeSource,
    sourceAfter: afterSource,
    archive: {
      targetRows: TARGET_ROWS,
      candidateRowsArchived: TARGET_ROWS,
      protectedRewriteRows: PROTECTED_REWRITE_ROWS,
      protectedRewriteRowsChanged: 0,
      newArchivedRevisionRows: TARGET_ROWS,
      oldRevisionRowsSuperseded: TARGET_ROWS,
      newSourceRows: TARGET_ROWS,
      newRelationRows: TARGET_ROWS,
      newEventRows: TARGET_ROWS,
      currentContentRowsChanged: 0,
      currentVerificationRowsChanged: 0,
      addressRowsChanged: 0,
      aclRowsChanged: 0,
      nonTargetRowsChanged: 0,
    },
    projections: {
      compatibilityRowsChanged: 0,
      currentFtsRowsChanged: 0,
      vectorRowsChanged: 0,
      relationProjectionRowsChanged: 0,
      pendingOutboxRowsChanged: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
    runtime: {
      v1FallbackReads: true,
      existingCandidateLifecycleMutationEnabled: false,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}

export function inspectLiveCandidateUnsafeTraceArchiveV1(input: {
  sourcePath: string;
  planPath: string;
  applyReceiptPath: string;
  planDigest: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceArchivePostcheckV1 {
  const loadedPlan = privateJson<LiveCandidateUnsafeTraceDispositionPlanV1>(input.planPath);
  const plan = validateLiveCandidateUnsafeTraceDispositionPlanV1(loadedPlan.value, input.planDigest);
  const loadedApply = privateJson<LiveCandidateUnsafeTraceArchiveReceiptV1>(input.applyReceiptPath);
  const apply = loadedApply.value;
  if (
    apply?.schemaVersion !== 1
    || apply.phase !== "clawlore-candidate-unsafe-trace-soft-archive-live-apply"
    || apply.status !== "applied"
    || apply.planDigest !== plan.planDigest
    || apply.planSha256 !== loadedPlan.sha256
    || apply.archive.targetRows !== TARGET_ROWS
    || apply.archive.candidateRowsArchived !== TARGET_ROWS
    || apply.archive.protectedRewriteRows !== PROTECTED_REWRITE_ROWS
    || apply.archive.protectedRewriteRowsChanged !== 0
    || apply.archive.currentContentRowsChanged !== 0
    || apply.archive.currentVerificationRowsChanged !== 0
    || apply.archive.addressRowsChanged !== 0
    || apply.archive.aclRowsChanged !== 0
    || apply.archive.nonTargetRowsChanged !== 0
    || Object.values(apply.projections).some((value) => value !== 0)
    || apply.database.integrity !== "ok"
    || apply.database.foreignKeyViolations !== 0
  ) throw new Error("unsafe trace archive apply receipt is invalid or outside the exact lane");
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const source = companionDispositionSourceStateV1(db);
    if (!sameCompanionDispositionSourceV1(source, apply.sourceAfter)) {
      throw new Error("live source no longer matches the unsafe trace archive apply receipt");
    }
    const archived = candidateRows(db, "archived");
    const archivedByHash = new Map(archived.map((row) => [hash(row.item_id), row]));
    const candidates = candidateRows(db);
    const candidateByHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    let archivedRows = 0;
    let validDispositionReceiptRows = 0;
    let supersedesRelationRows = 0;
    let archivedEventRows = 0;
    let projectionBindingRows = 0;
    for (const planned of plan.archiveRows) {
      const row = archivedByHash.get(planned.itemIdSha256);
      if (
        !row
        || row.lifecycle !== "archived"
        || row.verification !== "unverified"
        || hash(row.content) !== planned.contentDigest
        || row.category !== planned.category
      ) throw new Error("unsafe trace archive postcheck archived row is invalid");
      archivedRows += 1;
      const evidence = parseRecord(row.evidence_json);
      const receipt = evidence.unsafeTraceDispositionReceiptV1 as Record<string, unknown> | undefined;
      if (
        receipt?.rolloutId !== apply.rolloutId
        || receipt.planDigest !== plan.planDigest
        || receipt.archivedFromRevisionIdSha256 !== planned.currentRevisionIdSha256
        || receipt.normalizedContentDigest !== planned.normalizedContentDigest
        || receipt.archivedContentDigest !== planned.contentDigest
        || receipt.sourceLineageReceiptDigest !== planned.sourceLineageReceiptDigest
        || receipt.captureSafetyPattern !== planned.captureSafetyPattern
        || receipt.captureSafetyLane !== planned.captureSafetyLane
        || receipt.reason !== planned.reason
        || receipt.resultDigest !== planned.resultDigest
        || receipt.preservesContent !== true
        || receipt.preservesVerification !== true
        || receipt.preservesAddress !== true
        || receipt.preservesProjections !== true
        || receipt.excludesRewriteHoldLane !== true
      ) throw new Error("unsafe trace archive postcheck disposition receipt is invalid");
      validDispositionReceiptRows += 1;
      const relation = db.prepare(`SELECT rel.to_revision_id,r.lifecycle FROM memory_relations rel
        JOIN memory_revisions r ON r.revision_id=rel.to_revision_id
        WHERE rel.from_revision_id=? AND rel.relation_type='supersedes'`).get(row.current_revision_id) as
        Record<string, unknown> | undefined;
      if (!relation || hash(String(relation.to_revision_id)) !== planned.currentRevisionIdSha256
        || relation.lifecycle !== "superseded") {
        throw new Error("unsafe trace archive postcheck supersedes relation is invalid");
      }
      supersedesRelationRows += 1;
      const events = scalar(db, `SELECT COUNT(*) FROM memory_events
        WHERE item_id=? AND revision_id=? AND event_type='archived'
          AND actor='operator:bounded-unsafe-trace-disposition' AND reason=?`,
      row.item_id, row.current_revision_id, apply.rolloutId);
      if (events !== 1) throw new Error("unsafe trace archive postcheck event is invalid");
      archivedEventRows += events;
      const projections = [
        scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2 WHERE item_id=?", row.item_id),
        scalar(db, "SELECT COUNT(*) FROM memory_fts_v2 WHERE item_id=?", row.item_id),
        scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE item_id=?", row.item_id),
        scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2 WHERE item_id=?", row.item_id),
      ];
      if (projections.some((count) => count !== 1)) throw new Error("unsafe trace archive postcheck projection binding is invalid");
      projectionBindingRows += 1;
    }
    for (const planned of plan.rewriteDesigns) {
      const row = candidateByHash.get(planned.itemIdSha256);
      if (!row) throw new Error("unsafe trace archive postcheck rewrite hold is missing");
      assertLiveRowMatches(row, planned);
    }
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) throw new Error("unsafe trace archive postcheck database integrity failed");
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-unsafe-trace-soft-archive-postcheck",
      verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
      status: "pass",
      rolloutId: apply.rolloutId,
      planDigest: plan.planDigest,
      planSha256: loadedPlan.sha256,
      applyReceiptSha256: loadedApply.sha256,
      source,
      targetBinding: {
        archivedRows: TARGET_ROWS,
        protectedRewriteRows: PROTECTED_REWRITE_ROWS,
        protectedRewriteRowsChanged: 0,
        validDispositionReceiptRows: TARGET_ROWS,
        supersedesRelationRows: TARGET_ROWS,
        archivedEventRows: TARGET_ROWS,
        projectionBindingRows: TARGET_ROWS,
        mismatches: 0,
      },
      database: { integrity: "ok", foreignKeyViolations: 0 },
      runtime: apply.runtime,
    };
  } finally {
    db.close();
  }
}
