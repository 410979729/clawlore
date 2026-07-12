import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { buildLegacyMigrationBatchV2 } from "../migration/legacy-v2-migration.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
import { EXPERIENCE_V2_SCHEMA_SQL } from "../storage/sqlite-experience-v2.js";
import { TRUTH_V2_SCHEMA_SQL } from "../storage/sqlite-truth-v2.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

const CONTROL_MAX_BYTES = 128 * 1024;
const ROLLOUT_TABLES = [
  "clawlore_schema",
  "clawlore_rollouts_v2",
  "memory_items",
  "memory_revisions",
  "memory_sources",
  "memory_acl",
  "memory_relations",
  "memory_events",
  "projection_outbox",
  "memory_fts_v2",
  "memory_vector_projection_v2",
  "memory_relation_projection_v2",
  "subagent_snapshots_v2",
  "subagent_scratch_v2",
  "experience_episodes_v2",
  "procedural_playbooks_v2",
  "experience_events_v2",
] as const;

export interface LiveV2WriteRolloutReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-write-rollout";
  rolloutId: string;
  status: "applied";
  appliedAt: string;
  planDigest: string;
  approvalSha256: string;
  readinessSha256: string;
  source: { memoryTruthRows: number; memoryTruthLogicalDigest: string; unchanged: true };
  v2: {
    items: number;
    active: number;
    candidate: number;
    archived: number;
    ftsRows: number;
    vectorFallbackRows: number;
    relationProjectionRows: number;
    relationRows: number;
    outboxProcessed: number;
    outboxPending: number;
    experienceTables: number;
    experienceRows: number;
  };
  runtime: {
    v1FallbackReads: true;
    contextEngineEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

interface ApprovalControlV1 {
  schemaVersion: 1;
  rolloutId: string;
  mode: "v2-write";
  decision: "approved";
  actor: string;
  approvedAt: string;
  preserveV1Fallback: true;
  allowContextEngine: false;
  allowFinalRecallCutover: false;
}

function privateJson(path: string): { value: Record<string, unknown>; sha256: string } {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("rollout control is not a file");
  if ((info.mode & 0o077) !== 0) throw new Error("rollout control permissions must be 0600");
  if (info.size <= 0 || info.size > CONTROL_MAX_BYTES) throw new Error("rollout control size is invalid");
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rollout control is invalid");
  return { value, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function approval(path: string, rolloutId: string): { value: ApprovalControlV1; sha256: string } {
  const loaded = privateJson(path);
  const value = loaded.value;
  if (
    value.schemaVersion !== 1
    || value.rolloutId !== rolloutId
    || value.mode !== "v2-write"
    || value.decision !== "approved"
    || typeof value.actor !== "string"
    || !value.actor.trim()
    || typeof value.approvedAt !== "string"
    || !Number.isFinite(Date.parse(value.approvedAt))
    || value.preserveV1Fallback !== true
    || value.allowContextEngine !== false
    || value.allowFinalRecallCutover !== false
  ) throw new Error("operator approval is invalid or exceeds the authorized boundary");
  return { value: value as unknown as ApprovalControlV1, sha256: loaded.sha256 };
}

function readiness(path: string, rolloutId: string): {
  value: Record<string, any>;
  sha256: string;
} {
  const loaded = privateJson(path);
  const value = loaded.value as Record<string, any>;
  const rollout = value.rollout as Record<string, unknown> | undefined;
  const evidence = value.evidenceBindings as Record<string, unknown> | undefined;
  if (
    value.schemaVersion !== 1
    || value.status !== "ready"
    || value.compatibilityValid !== true
    || rollout?.rolloutId !== rolloutId
    || rollout.requestedMode !== "v2-write"
    || rollout.currentMode !== "shadow"
    || rollout.ready !== true
    || rollout.readOnly !== false
    || rollout.requiresOperatorApproval !== true
    || !Array.isArray(rollout.blockingReasons)
    || rollout.blockingReasons.length !== 0
    || value.authorizesV2Writes !== false
    || value.operatorApprovalPresent !== false
    || value.writeActivationAllowed !== false
    || value.manualDisposition !== "candidate"
    || typeof evidence?.migrationPlanDigest !== "string"
    || typeof evidence?.memoryTruthLogicalDigest !== "string"
    || typeof evidence?.memoryTruthRows !== "number"
  ) throw new Error("V2-write readiness is invalid or stale");
  return { value, sha256: loaded.sha256 };
}

function scalar(db: DatabaseSync, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function existingRolloutTables(db: DatabaseSync): string[] {
  const placeholders = ROLLOUT_TABLES.map(() => "?").join(",");
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (${placeholders}) ORDER BY name`)
    .all(...ROLLOUT_TABLES) as Array<{ name: string }>).map((row) => row.name);
}

function insertOutbox(db: DatabaseSync, input: {
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

export async function executeLiveV2WriteRolloutV1(input: {
  sourcePath: string;
  readinessPath: string;
  approvalPath: string;
  rolloutId: string;
  defaults: { tenantId: string; agentId: string; workspaceId?: string };
  expectedV1VectorRows: number;
  now?: () => Date;
}): Promise<LiveV2WriteRolloutReceiptV1> {
  if (!Number.isInteger(input.expectedV1VectorRows) || input.expectedV1VectorRows < 0) {
    throw new Error("verified V1 vector row count is required");
  }
  const ready = readiness(input.readinessPath, input.rolloutId);
  const approved = approval(input.approvalPath, input.rolloutId);
  const evidence = ready.value.evidenceBindings as Record<string, unknown>;
  const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    before.memoryTruth.rowCount !== evidence.memoryTruthRows
    || before.memoryTruth.logicalDigest !== evidence.memoryTruthLogicalDigest
  ) throw new Error("live legacy truth no longer matches approved readiness");
  if (input.expectedV1VectorRows !== before.memoryTruth.rowCount) {
    throw new Error("V1 vector fallback is not fully converged");
  }

  const migration = buildLegacyMigrationBatchV2({ legacyPath: input.sourcePath, defaults: input.defaults });
  if (migration.plan.planDigest !== evidence.migrationPlanDigest) {
    throw new Error("live migration plan no longer matches approved readiness");
  }

  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  const db = new DatabaseSync(input.sourcePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
  const preexisting = existingRolloutTables(db);
  if (preexisting.length > 0) {
    db.close();
    throw new Error(`V2 rollout schema already exists: ${preexisting.join(",")}`);
  }
  const appliedAt = (input.now?.() ?? new Date()).toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(TRUTH_V2_SCHEMA_SQL);
    db.exec(EXPERIENCE_V2_SCHEMA_SQL);
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
      CREATE TABLE memory_vector_projection_v2 (
        item_id TEXT PRIMARY KEY,legacy_id TEXT NOT NULL UNIQUE,backend TEXT NOT NULL,
        state TEXT NOT NULL,verified_at TEXT NOT NULL
      );
      CREATE TABLE memory_relation_projection_v2 (
        item_id TEXT PRIMARY KEY,state TEXT NOT NULL,verified_at TEXT NOT NULL
      );
      CREATE TABLE clawlore_rollouts_v2 (
        rollout_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,approval_sha256 TEXT NOT NULL,
        readiness_sha256 TEXT NOT NULL,legacy_logical_digest TEXT NOT NULL,rows_applied INTEGER NOT NULL,
        applied_at TEXT NOT NULL,v1_fallback_reads INTEGER NOT NULL,context_engine_enabled INTEGER NOT NULL,
        final_recall_cutover_enabled INTEGER NOT NULL
      );
    `);

    for (const row of migration.rows) {
      const itemId = `legacy:${row.legacyId}`;
      const revisionId = randomUUID();
      const address = row.address;
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,NULL,?)`).run(
        revisionId, itemId, 1, row.content.trim(), row.lifecycle, row.verification, appliedAt,
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
        row.lifecycle, row.verification, appliedAt, appliedAt,
      );
      db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(
        randomUUID(), revisionId, "legacy", row.legacyId, row.observedAt,
        JSON.stringify({
          classification: row.classification,
          reviewRequired: row.reviewRequired,
          verificationDebt: row.verificationDebt,
          rolloutId: input.rolloutId,
        }),
      );
      db.prepare(`INSERT INTO memory_acl
        (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), itemId, address.principalId, address.visibility, "{}", appliedAt);
      db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        randomUUID(), itemId, revisionId, "remembered", "operator:approved-rollout", input.rolloutId, appliedAt,
      );
      db.prepare("INSERT INTO memory_fts_v2(item_id,content,category) VALUES (?,?,?)")
        .run(itemId, row.content.trim(), row.category.trim());
      db.prepare(`INSERT INTO memory_vector_projection_v2
        (item_id,legacy_id,backend,state,verified_at) VALUES (?,?,?,?,?)`)
        .run(itemId, row.legacyId, "v1-lancedb-fallback", "fallback_verified", appliedAt);
      db.prepare(`INSERT INTO memory_relation_projection_v2
        (item_id,state,verified_at) VALUES (?,?,?)`)
        .run(itemId, "no_legacy_relation_source", appliedAt);
      insertOutbox(db, { itemId, revisionId, now: appliedAt });
    }

    db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,approval_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(
      input.rolloutId, migration.plan.planDigest, approved.sha256, ready.sha256,
      before.memoryTruth.logicalDigest, migration.rows.length, appliedAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    db.close();
    throw error;
  }

  const counts = {
    items: scalar(db, "SELECT COUNT(*) FROM memory_items"),
    active: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    candidate: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    archived: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    ftsRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
    vectorFallbackRows: scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE state='fallback_verified'"),
    relationProjectionRows: scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2"),
    relationRows: scalar(db, "SELECT COUNT(*) FROM memory_relations"),
    outboxProcessed: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NOT NULL"),
    outboxPending: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
    experienceTables: scalar(db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
      ('subagent_snapshots_v2','subagent_scratch_v2','experience_episodes_v2','procedural_playbooks_v2','experience_events_v2')`),
    experienceRows: scalar(db, `SELECT
      (SELECT COUNT(*) FROM subagent_snapshots_v2)+(SELECT COUNT(*) FROM subagent_scratch_v2)
      +(SELECT COUNT(*) FROM experience_episodes_v2)+(SELECT COUNT(*) FROM procedural_playbooks_v2)
      +(SELECT COUNT(*) FROM experience_events_v2)`),
  };
  db.close();
  const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    after.memoryTruth.rowCount !== before.memoryTruth.rowCount
    || after.memoryTruth.logicalDigest !== before.memoryTruth.logicalDigest
    || counts.items !== migration.rows.length
    || counts.ftsRows !== migration.rows.length
    || counts.vectorFallbackRows !== migration.rows.length
    || counts.relationProjectionRows !== migration.rows.length
    || counts.outboxProcessed !== migration.rows.length * 3
    || counts.outboxPending !== 0
    || counts.experienceTables !== 5
  ) throw new Error("post-apply V2 convergence verification failed");

  return {
    schemaVersion: 1,
    phase: "clawlore-v2-live-write-rollout",
    rolloutId: input.rolloutId,
    status: "applied",
    appliedAt,
    planDigest: migration.plan.planDigest,
    approvalSha256: approved.sha256,
    readinessSha256: ready.sha256,
    source: {
      memoryTruthRows: after.memoryTruth.rowCount,
      memoryTruthLogicalDigest: after.memoryTruth.logicalDigest,
      unchanged: true,
    },
    v2: { ...counts },
    runtime: {
      v1FallbackReads: true,
      contextEngineEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}
