import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { buildLegacyMigrationBatchV2 } from "../migration/legacy-v2-migration.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
import {
  createLiveV1AppendDeltaPlanV1,
  type LiveV1AppendDeltaPlanReceiptV1,
} from "./live-v1-append-delta-plan.js";

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

export interface LiveV1AppendDeltaApplyReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-v1-append-delta";
  rolloutId: string;
  status: "applied";
  appliedAt: string;
  planDigest: string;
  planSha256: string;
  snapshotReceiptSha256: string;
  snapshotArchiveSha256: string;
  source: {
    v1Rows: number;
    memoryTruthLogicalDigest: string;
    unchanged: true;
  };
  v2: {
    beforeRows: number;
    afterRows: number;
    deltaRows: number;
    activeRows: number;
    candidateRows: number;
    archivedRows: number;
    existingCanonicalRowsChanged: 0;
    existingLifecycleRowsChanged: 0;
    existingVerificationRowsChanged: 0;
    existingEvidenceRowsChanged: 0;
  };
  projections: {
    compatibilityRows: number;
    ftsRows: number;
    vectorRows: number;
    relationProjectionRows: number;
    newProcessedOutboxRows: number;
    pendingOutboxRows: 0;
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

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateBytes(path: string, maximumBytes: number): { bytes: Buffer; sha256: string } {
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

function loadPlan(path: string, rolloutId: string, planDigest: string): {
  value: LiveV1AppendDeltaPlanReceiptV1;
  sha256: string;
} {
  const loaded = privateJson<LiveV1AppendDeltaPlanReceiptV1>(path);
  const value = loaded.value;
  if (
    value.schemaVersion !== 1
    || value.phase !== "clawlore-v1-append-delta-plan"
    || value.proposedRolloutId !== rolloutId
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsRawIdentifiers !== false
    || value.proposed.planDigest !== planDigest
    || value.proposed.activeRows !== 0
    || value.proposed.candidateRows <= 0
    || value.proposed.archivedRows !== 0
    || value.proposed.invalidMetadataRows !== 0
    || value.proposed.reviewRequiredRows !== value.proposed.candidateRows
    || value.proposed.rows.length !== value.source.deltaRows
    || value.decision.deltaWriteReady !== true
    || value.decision.requiresFreshEncryptedSnapshot !== true
    || value.decision.finalRecallCutoverReady !== false
    || value.authorizesDeltaWrite !== false
    || value.authorizesLifecyclePromotion !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
  ) throw new Error("append-delta plan is invalid or exceeds the bounded write contract");
  return loaded;
}

function loadFreshSnapshot(input: {
  receiptPath: string;
  archivePath: string;
  now: Date;
  maximumAgeSeconds: number;
}): { value: SnapshotReceiptV1; sha256: string } {
  const loaded = privateJson<SnapshotReceiptV1>(input.receiptPath, 128 * 1024);
  const archive = privateBytes(input.archivePath, 1024 * 1024 * 1024);
  const createdAt = Date.parse(loaded.value.createdAt);
  const ageSeconds = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((input.now.getTime() - createdAt) / 1000))
    : Number.POSITIVE_INFINITY;
  const value = loaded.value;
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

function scalar(db: DatabaseSync, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function assertAppendDeltaPrerequisites(sourcePath: string): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const required = [
      "memory_items", "memory_revisions", "memory_sources", "memory_acl", "memory_events",
      "projection_outbox", "memory_fts_compat_v2", "memory_fts_v2",
      "memory_vector_projection_v2", "memory_relation_projection_v2", "clawlore_rollouts_v2",
    ];
    const placeholders = required.map(() => "?").join(",");
    const present = new Set((db.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (${placeholders})`,
    ).all(...required) as Array<{ name: string }>).map((row) => row.name));
    const missing = required.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(
        `append-delta prerequisite missing: ${missing.join(",")}; complete the baseline V2 rollout and compatibility backfill first`,
      );
    }
  } finally {
    db.close();
  }
}

function ensureRolloutControlColumn(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(clawlore_rollouts_v2)").all() as Array<{ name: string }>)
    .map((row) => row.name));
  if (columns.has("control_sha256")) return;
  if (!columns.has("approval_sha256")) throw new Error("rollout control digest column is missing");
  db.exec("ALTER TABLE clawlore_rollouts_v2 RENAME COLUMN approval_sha256 TO control_sha256");
}

function lifecycleCounts(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT lifecycle,COUNT(*) AS rows FROM memory_items GROUP BY lifecycle ORDER BY lifecycle")
    .all() as Array<{ lifecycle: string; rows: number }>;
  return Object.fromEntries(rows.map((row) => [row.lifecycle, Number(row.rows)]));
}

function digestRows(db: DatabaseSync, sql: string, itemIds: string[]): string {
  if (itemIds.length === 0) return hash("[]");
  const placeholders = itemIds.map(() => "?").join(",");
  return hash(JSON.stringify(db.prepare(sql.replace("__ITEM_IDS__", placeholders)).all(...itemIds)));
}

function existingStateDigests(db: DatabaseSync, itemIds: string[]): Record<string, string> {
  return {
    canonical: digestRows(db, `SELECT * FROM memory_items WHERE item_id IN (__ITEM_IDS__) ORDER BY item_id`, itemIds),
    revisions: digestRows(db, `SELECT * FROM memory_revisions WHERE item_id IN (__ITEM_IDS__) ORDER BY item_id,revision_no`, itemIds),
    sources: digestRows(db, `SELECT s.* FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
      WHERE r.item_id IN (__ITEM_IDS__) ORDER BY r.item_id,s.source_id`, itemIds),
    acl: digestRows(db, `SELECT * FROM memory_acl WHERE item_id IN (__ITEM_IDS__) ORDER BY item_id,acl_id`, itemIds),
    events: digestRows(db, `SELECT * FROM memory_events WHERE item_id IN (__ITEM_IDS__) ORDER BY item_id,event_id`, itemIds),
  };
}

function assertCurrentPlanMatch(expected: LiveV1AppendDeltaPlanReceiptV1, current: LiveV1AppendDeltaPlanReceiptV1): void {
  for (const field of ["baseline", "source", "proposed", "projectionWork", "decision"] as const) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(current[field])) {
      throw new Error("live delta set or plan digest drifted after planning");
    }
  }
}

function insertProcessedOutbox(db: DatabaseSync, input: {
  itemId: string;
  revisionId: string;
  now: string;
}): void {
  for (const projection of ["fts", "vector", "relations"] as const) {
    db.prepare(`INSERT INTO projection_outbox
      (outbox_id,item_id,revision_id,operation,projection,attempts,available_at,created_at,processed_at,last_error)
      VALUES (?,?,?,?,?,0,?,?,?,NULL)`).run(
      randomUUID(), input.itemId, input.revisionId, "upsert", projection,
      input.now, input.now, input.now,
    );
  }
}

export async function executeLiveV1AppendDeltaV1(input: {
  sourcePath: string;
  baselineReceiptPath: string;
  planPath: string;
  snapshotArchivePath: string;
  snapshotReceiptPath: string;
  rolloutId: string;
  planDigest: string;
  defaults: { tenantId: string; agentId: string; workspaceId?: string };
  now?: () => Date;
  maximumSnapshotAgeSeconds?: number;
}): Promise<LiveV1AppendDeltaApplyReceiptV1> {
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
  assertAppendDeltaPrerequisites(input.sourcePath);
  const currentPlan = await createLiveV1AppendDeltaPlanV1({
    sourcePath: input.sourcePath,
    baselineReceiptPath: input.baselineReceiptPath,
    proposedRolloutId: input.rolloutId,
    defaults: input.defaults,
    now: () => appliedAtDate,
  });
  assertCurrentPlanMatch(plan.value, currentPlan);
  const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    legacyBefore.schemaDigest !== snapshot.value.snapshot.schemaDigest
    || legacyBefore.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
    || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest
  ) throw new Error("live truth no longer matches the fresh encrypted snapshot");

  const migration = buildLegacyMigrationBatchV2({ legacyPath: input.sourcePath, defaults: input.defaults });
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  const db = new DatabaseSync(input.sourcePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
  const existingItemIds = (db.prepare("SELECT item_id FROM memory_items ORDER BY item_id").all() as Array<{ item_id: string }>)
    .map((row) => String(row.item_id));
  const existingItemSet = new Set(existingItemIds);
  const delta = migration.rows.filter((row) => !existingItemSet.has(`legacy:${row.legacyId}`));
  if (delta.length !== plan.value.source.deltaRows) {
    db.close();
    throw new Error("live append-only delta coverage no longer matches the plan");
  }
  const existingDigests = existingStateDigests(db, existingItemIds);
  const beforeV2Rows = existingItemIds.length;
  const beforeLifecycle = lifecycleCounts(db);
  const beforeCompatibility = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
  const beforeFts = scalar(db, "SELECT COUNT(*) FROM memory_fts_v2");
  const beforeVector = scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2");
  const beforeRelationProjection = scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2");
  const beforeProcessedOutbox = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NOT NULL");
  const beforePendingOutbox = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
  const appliedAt = appliedAtDate.toISOString();
  const newItemIds: string[] = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    ensureRolloutControlColumn(db);
    for (const row of delta) {
      if (
        row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || row.verificationDebt === "none"
        || row.reviewRequired !== true
      ) throw new Error("delta row no longer satisfies the candidate-only classification");
      const itemId = `legacy:${row.legacyId}`;
      const revisionId = randomUUID();
      const address = row.address;
      const legacy = db.prepare("SELECT metadata_text FROM memory_truth WHERE id=?").get(row.legacyId) as {
        metadata_text: string;
      } | undefined;
      if (!legacy) throw new Error("delta legacy source row disappeared during apply");
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,NULL,?)`).run(
        revisionId, itemId, 1, row.content.trim(), "candidate", "unverified", appliedAt,
      );
      db.prepare(`INSERT INTO memory_items
        (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
         visibility,retention,workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,
         lifecycle,verification,valid_until,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`).run(
        itemId, revisionId, 1, row.content.trim(), row.category.trim(), JSON.stringify(address),
        address.tenantId, address.principalId, address.agentId, address.visibility, address.retention,
        address.workspaceId ?? null, address.projectId ?? null, address.conversationId ?? null,
        address.threadId ?? null, address.customerId ?? null, address.taskId ?? null,
        "candidate", "unverified", appliedAt, appliedAt,
      );
      db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(
        randomUUID(), revisionId, "legacy", row.legacyId, row.observedAt,
        JSON.stringify({
          classification: row.classification,
          reviewRequired: true,
          verificationDebt: row.verificationDebt,
          rolloutId: input.rolloutId,
          appendOnlyV1Delta: true,
        }),
      );
      db.prepare(`INSERT INTO memory_acl
        (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), itemId, address.principalId, address.visibility, "{}", appliedAt);
      db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        randomUUID(), itemId, revisionId, "remembered", "operator:bounded-delta-rollout", input.rolloutId, appliedAt,
      );
      db.prepare("INSERT INTO memory_fts_compat_v2(item_id,content,metadata_text) VALUES (?,?,?)")
        .run(itemId, row.content.trim(), String(legacy.metadata_text || ""));
      db.prepare("INSERT INTO memory_fts_v2(item_id,content,category) VALUES (?,?,?)")
        .run(itemId, row.content.trim(), row.category.trim());
      db.prepare(`INSERT INTO memory_vector_projection_v2
        (item_id,legacy_id,backend,state,verified_at) VALUES (?,?,?,?,?)`)
        .run(itemId, row.legacyId, "v1-lancedb-fallback", "fallback_verified", appliedAt);
      db.prepare(`INSERT INTO memory_relation_projection_v2
        (item_id,state,verified_at) VALUES (?,?,?)`).run(itemId, "no_legacy_relation_source", appliedAt);
      insertProcessedOutbox(db, { itemId, revisionId, now: appliedAt });
      newItemIds.push(itemId);
    }
    db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(
      input.rolloutId, input.planDigest, plan.sha256, snapshot.sha256,
      legacyBefore.memoryTruth.logicalDigest, delta.length, appliedAt,
    );
    const inTransactionDigests = existingStateDigests(db, existingItemIds);
    if (
      JSON.stringify(inTransactionDigests) !== JSON.stringify(existingDigests)
      || scalar(db, "SELECT COUNT(*) FROM memory_items") !== beforeV2Rows + delta.length
      || scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2") !== beforeCompatibility + delta.length
      || scalar(db, "SELECT COUNT(*) FROM memory_fts_v2") !== beforeFts + delta.length
      || scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2") !== beforeVector + delta.length
      || scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2") !== beforeRelationProjection + delta.length
      || scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NOT NULL")
        !== beforeProcessedOutbox + delta.length * 3
      || scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL") !== beforePendingOutbox
    ) throw new Error("transaction exceeded the append-only delta boundary");
    const newLifecycle = scalar(db,
      `SELECT COUNT(*) FROM memory_items WHERE item_id IN (${newItemIds.map(() => "?").join(",")})
       AND lifecycle='candidate' AND verification='unverified'`, ...newItemIds);
    if (newLifecycle !== delta.length || JSON.stringify(beforeLifecycle) !== JSON.stringify(lifecycleCounts(db))) {
      const afterLifecycle = lifecycleCounts(db);
      const expected = { ...beforeLifecycle, candidate: (beforeLifecycle.candidate ?? 0) + delta.length };
      if (JSON.stringify(afterLifecycle) !== JSON.stringify(expected)) {
        throw new Error("lifecycle state exceeded the candidate-only delta boundary");
      }
    }
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) throw new Error("database verification failed before commit");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    db.close();
    throw error;
  }

  const afterDigests = existingStateDigests(db, existingItemIds);
  const afterLifecycle = lifecycleCounts(db);
  const afterRows = scalar(db, "SELECT COUNT(*) FROM memory_items");
  const compatibilityRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
  const ftsRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_v2");
  const vectorRows = scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2");
  const relationProjectionRows = scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2");
  const processedOutboxRows = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NOT NULL");
  const pendingOutboxRows = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
  const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
  const foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  db.close();
  const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    JSON.stringify(afterDigests) !== JSON.stringify(existingDigests)
    || afterRows !== beforeV2Rows + delta.length
    || compatibilityRows !== beforeCompatibility + delta.length
    || ftsRows !== beforeFts + delta.length
    || vectorRows !== beforeVector + delta.length
    || relationProjectionRows !== beforeRelationProjection + delta.length
    || processedOutboxRows !== beforeProcessedOutbox + delta.length * 3
    || pendingOutboxRows !== 0
    || integrity !== "ok"
    || foreignKeyViolations !== 0
    || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
    || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest
  ) throw new Error("post-commit append-delta convergence verification failed");

  return {
    schemaVersion: 1,
    phase: "clawlore-v2-live-v1-append-delta",
    rolloutId: input.rolloutId,
    status: "applied",
    appliedAt,
    planDigest: input.planDigest,
    planSha256: plan.sha256,
    snapshotReceiptSha256: snapshot.sha256,
    snapshotArchiveSha256: snapshot.value.archiveSha256,
    source: {
      v1Rows: legacyAfter.memoryTruth.rowCount,
      memoryTruthLogicalDigest: legacyAfter.memoryTruth.logicalDigest,
      unchanged: true,
    },
    v2: {
      beforeRows: beforeV2Rows,
      afterRows,
      deltaRows: delta.length,
      activeRows: afterLifecycle.active ?? 0,
      candidateRows: afterLifecycle.candidate ?? 0,
      archivedRows: afterLifecycle.archived ?? 0,
      existingCanonicalRowsChanged: 0,
      existingLifecycleRowsChanged: 0,
      existingVerificationRowsChanged: 0,
      existingEvidenceRowsChanged: 0,
    },
    projections: {
      compatibilityRows,
      ftsRows,
      vectorRows,
      relationProjectionRows,
      newProcessedOutboxRows: processedOutboxRows - beforeProcessedOutbox,
      pendingOutboxRows: 0,
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
