import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolvePrincipalWriteTarget } from "../../principal-write-boundary.js";
import { resolveRuntimeMemoryBoundary } from "../../runtime-memory-boundary.js";
import {
  classifyLegacyPrincipalAttributionV1,
  type LegacyPrincipalAttributionLaneV1,
} from "../migration/legacy-principal-attribution.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

interface LegacyTruthStateRow {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  metadata_text: string;
  updated_at: number;
}

interface V2StateRow {
  item_id: string;
  current_revision_id: string;
  address_json: string;
  principal_id: string;
  visibility: string;
  lifecycle: string;
  verification: string;
}

export function computeLegacyPrincipalTruthStateDigestV1(row: {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  metadata_text: string;
  updated_at: number;
}): string {
  return hash(stableJson({
    legacyId: row.id,
    contentSha256: hash(String(row.text)),
    category: row.category,
    scope: row.scope,
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadataSha256: hash(String(row.metadata)),
    metadataTextSha256: hash(String(row.metadata_text)),
    updatedAt: Number(row.updated_at),
  }));
}

export function computePrincipalV2StateDigestV1(input: {
  v2: Record<string, unknown>;
  acl: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
}): string {
  return hash(stableJson(input));
}

export interface PrincipalScopePlanRowV1 {
  legacyIdSha256: string;
  itemIdSha256: string;
  currentStateDigest: string;
  lane: LegacyPrincipalAttributionLaneV1;
  evidenceFields: string[];
  referenceDigest: string;
  principalAssignmentEligible: boolean;
  migrationEligible: boolean;
  v2Mirrored: boolean;
  v2StateDigest?: string;
  v2AddressCompatible: boolean;
  ftsReady: boolean;
  lifecycleProjectionReady: boolean;
  aclReady: boolean;
  currentSourceReady: boolean;
}

export interface LivePrincipalScopePlanV1 {
  schemaVersion: 1;
  phase: "clawlore-live-principal-scope-plan";
  createdAt: string;
  proposedMigrationId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  target: {
    contract: "openclaw-scope-v1";
    kind: "private";
    scope: string;
    principalHash: string;
    sessionKeySha256: string;
    sourceScopeSha256: string;
  };
  source: {
    memoryTruthRows: number;
    memoryTruthLogicalDigest: string;
    schemaDigest: string;
    ftsRows: number;
    lifecycleProjectionRows: number;
    v2Rows: number;
    integrity: "ok";
    foreignKeyViolations: 0;
    sourceUnchangedDuringPlan: true;
  };
  lanes: Record<LegacyPrincipalAttributionLaneV1, number>;
  summary: {
    targetEvidenceRows: number;
    principalAssignmentRows: number;
    migrationEligibleRows: number;
    alreadyAssignedRows: number;
    unexpectedTargetScopeRows: number;
    v2MirroredAssignmentRows: number;
    unmirroredAssignmentRows: number;
    incompatibleV2AssignmentRows: number;
    ftsUnreadyAssignmentRows: number;
    lifecycleProjectionUnreadyAssignmentRows: number;
    aclUnreadyAssignmentRows: number;
    currentSourceUnreadyAssignmentRows: number;
  };
  rows: PrincipalScopePlanRowV1[];
  decision: {
    assignmentReady: boolean;
    requiresFreshEncryptedSnapshot: true;
    automaticLifecyclePromotionRows: 0;
    finalRecallCutoverReady: false;
  };
  authorizesScopeMutation: false;
  authorizesLifecycleMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  planDigest: string;
}

const LANES: LegacyPrincipalAttributionLaneV1[] = [
  "target_private_source_scope",
  "target_private_already_assigned",
  "target_private_unexpected_scope",
  "other_private_session",
  "conversation_session",
  "conflicting_session_reference",
  "malformed_session_reference",
  "derived_system_reference",
  "manual_unattributed",
  "opaque_session_reference",
  "no_identity_reference",
  "invalid_metadata",
];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function planCore(plan: Omit<LivePrincipalScopePlanV1, "createdAt" | "planDigest">): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    phase: plan.phase,
    proposedMigrationId: plan.proposedMigrationId,
    readOnly: plan.readOnly,
    queryOnly: plan.queryOnly,
    emitsMemoryContent: plan.emitsMemoryContent,
    emitsTranscriptContent: plan.emitsTranscriptContent,
    emitsRawIdentifiers: plan.emitsRawIdentifiers,
    target: plan.target,
    source: plan.source,
    lanes: plan.lanes,
    summary: plan.summary,
    rows: plan.rows,
    decision: plan.decision,
    authorizesScopeMutation: plan.authorizesScopeMutation,
    authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
    authorizesContextEngine: plan.authorizesContextEngine,
    authorizesPromptMutation: plan.authorizesPromptMutation,
    authorizesFinalRecall: plan.authorizesFinalRecall,
  };
}

export function computeLivePrincipalScopePlanDigestV1(plan: LivePrincipalScopePlanV1): string {
  const { createdAt: _createdAt, planDigest: _planDigest, ...withoutDigest } = plan;
  return hash(stableJson(planCore(withoutDigest)));
}

export async function createLivePrincipalScopePlanV1(input: {
  sourcePath: string;
  targetSessionKey: string;
  sourceScope: string;
  proposedMigrationId: string;
  now?: () => Date;
}): Promise<LivePrincipalScopePlanV1> {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedMigrationId)) {
    throw new Error("proposed principal-scope migration id is invalid");
  }
  if (!input.sourceScope || input.sourceScope !== input.sourceScope.trim()) {
    throw new Error("principal-scope source scope must be explicit and trimmed");
  }
  const target = resolvePrincipalWriteTarget({ sessionKey: input.targetSessionKey });
  const boundary = resolveRuntimeMemoryBoundary({ runtimeContext: { sessionKey: input.targetSessionKey } });
  if (
    target.kind !== "private"
    || !target.principalHash
    || boundary.kind !== "private"
    || !boundary.principalKey
  ) throw new Error("principal-scope target must resolve to one exact private principal");

  const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (before.integrity !== "ok" || before.foreignKeyViolations !== 0) {
    throw new Error("principal-scope source integrity check failed");
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<LegacyPrincipalAttributionLaneV1, number>;
  const rows: PrincipalScopePlanRowV1[] = [];
  let ftsRows = 0;
  let lifecycleProjectionRows = 0;
  let v2Rows = 0;
  try {
    ftsRows = scalar(db, "SELECT COUNT(*) FROM memory_truth_fts");
    const hasLifecycleProjection = hasTable(db, "memory_lifecycle_projection");
    lifecycleProjectionRows = hasLifecycleProjection
      ? scalar(db, "SELECT COUNT(*) FROM memory_lifecycle_projection")
      : 0;
    v2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
    const truthRows = db.prepare(`SELECT id,text,category,scope,importance,timestamp,metadata,
      metadata_text,updated_at FROM memory_truth ORDER BY id`).all() as LegacyTruthStateRow[];
    const v2Statement = db.prepare(`SELECT item_id,current_revision_id,address_json,principal_id,
      visibility,lifecycle,verification FROM memory_items WHERE item_id=?`);
    const aclStatement = db.prepare(`SELECT acl_id,owner_principal_id,visibility,policy_json,created_at
      FROM memory_acl WHERE item_id=? ORDER BY acl_id`);
    const sourceStatement = db.prepare(`SELECT source_id,evidence_json FROM memory_sources
      WHERE revision_id=? ORDER BY source_id`);
    const ftsStatement = db.prepare("SELECT COUNT(*) AS rows FROM memory_truth_fts WHERE memory_id=?");
    const lifecycleStatement = hasLifecycleProjection
      ? db.prepare(`SELECT scope,truth_updated_at FROM memory_lifecycle_projection WHERE memory_id=?`)
      : undefined;
    for (const row of truthRows) {
      const attribution = classifyLegacyPrincipalAttributionV1({
        metadata: String(row.metadata || "{}"),
        currentScope: String(row.scope),
        sourceScope: input.sourceScope,
        targetScope: target.scope,
        targetSessionKey: input.targetSessionKey,
      });
      lanes[attribution.lane] += 1;
      if (!attribution.targetEvidence) continue;
      const itemId = `legacy:${row.id}`;
      const v2 = v2Statement.get(itemId) as V2StateRow | undefined;
      const acl = v2 ? aclStatement.all(itemId) as Array<Record<string, unknown>> : [];
      const sources = v2
        ? sourceStatement.all(v2.current_revision_id) as Array<Record<string, unknown>>
        : [];
      const lifecycle = lifecycleStatement?.get(row.id) as {
        scope?: string;
        truth_updated_at?: number;
      } | undefined;
      const v2AddressCompatible = !v2
        || v2.principal_id === "legacy:unresolved"
        || v2.principal_id === boundary.principalKey;
      const principalAssignmentEligible = attribution.migrationEligible
        || attribution.lane === "target_private_already_assigned";
      rows.push({
        legacyIdSha256: hash(row.id),
        itemIdSha256: hash(itemId),
        currentStateDigest: computeLegacyPrincipalTruthStateDigestV1(row),
        lane: attribution.lane,
        evidenceFields: attribution.evidenceFields,
        referenceDigest: attribution.referenceDigest ?? hash(""),
        principalAssignmentEligible,
        migrationEligible: attribution.migrationEligible,
        v2Mirrored: Boolean(v2),
        ...(v2 ? { v2StateDigest: computePrincipalV2StateDigestV1({
          v2: v2 as unknown as Record<string, unknown>, acl, sources,
        }) } : {}),
        v2AddressCompatible,
        ftsReady: Number((ftsStatement.get(row.id) as { rows?: number } | undefined)?.rows ?? 0) === 1,
        lifecycleProjectionReady: Boolean(
          lifecycle
          && lifecycle.scope === row.scope
          && Number(lifecycle.truth_updated_at) === Number(row.updated_at),
        ),
        aclReady: !v2 || acl.length === 1,
        currentSourceReady: !v2 || sources.length === 1,
      });
    }
  } finally {
    db.close();
  }
  rows.sort((left, right) => left.legacyIdSha256.localeCompare(right.legacyIdSha256));
  const assignmentRows = rows.filter((row) => row.principalAssignmentEligible);
  const migrationRows = rows.filter((row) => row.migrationEligible);
  const summary = {
    targetEvidenceRows: rows.length,
    principalAssignmentRows: assignmentRows.length,
    migrationEligibleRows: migrationRows.length,
    alreadyAssignedRows: rows.filter((row) => row.lane === "target_private_already_assigned").length,
    unexpectedTargetScopeRows: rows.filter((row) => row.lane === "target_private_unexpected_scope").length,
    v2MirroredAssignmentRows: assignmentRows.filter((row) => row.v2Mirrored).length,
    unmirroredAssignmentRows: assignmentRows.filter((row) => !row.v2Mirrored).length,
    incompatibleV2AssignmentRows: assignmentRows.filter((row) => !row.v2AddressCompatible).length,
    ftsUnreadyAssignmentRows: assignmentRows.filter((row) => !row.ftsReady).length,
    lifecycleProjectionUnreadyAssignmentRows:
      assignmentRows.filter((row) => !row.lifecycleProjectionReady).length,
    aclUnreadyAssignmentRows: assignmentRows.filter((row) => !row.aclReady).length,
    currentSourceUnreadyAssignmentRows: assignmentRows.filter((row) => !row.currentSourceReady).length,
  };
  const assignmentReady = assignmentRows.length > 0
    && migrationRows.length > 0
    && summary.unmirroredAssignmentRows === 0
    && summary.incompatibleV2AssignmentRows === 0
    && summary.ftsUnreadyAssignmentRows === 0
    && summary.lifecycleProjectionUnreadyAssignmentRows === 0
    && summary.aclUnreadyAssignmentRows === 0
    && summary.currentSourceUnreadyAssignmentRows === 0
    && summary.unexpectedTargetScopeRows === 0
    && ftsRows === before.memoryTruth.rowCount
    && lifecycleProjectionRows === before.memoryTruth.rowCount;
  const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
  if (
    after.schemaDigest !== before.schemaDigest
    || after.memoryTruth.rowCount !== before.memoryTruth.rowCount
    || after.memoryTruth.logicalDigest !== before.memoryTruth.logicalDigest
  ) throw new Error("principal-scope source changed during planning");
  const withoutDigest: Omit<LivePrincipalScopePlanV1, "createdAt" | "planDigest"> = {
    schemaVersion: 1,
    phase: "clawlore-live-principal-scope-plan",
    proposedMigrationId: input.proposedMigrationId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    target: {
      contract: target.contract,
      kind: "private",
      scope: target.scope,
      principalHash: target.principalHash,
      sessionKeySha256: hash(input.targetSessionKey),
      sourceScopeSha256: hash(input.sourceScope),
    },
    source: {
      memoryTruthRows: before.memoryTruth.rowCount,
      memoryTruthLogicalDigest: before.memoryTruth.logicalDigest,
      schemaDigest: before.schemaDigest,
      ftsRows,
      lifecycleProjectionRows,
      v2Rows,
      integrity: "ok",
      foreignKeyViolations: 0,
      sourceUnchangedDuringPlan: true,
    },
    lanes,
    summary,
    rows,
    decision: {
      assignmentReady,
      requiresFreshEncryptedSnapshot: true,
      automaticLifecyclePromotionRows: 0,
      finalRecallCutoverReady: false,
    },
    authorizesScopeMutation: false,
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
  };
  return {
    ...withoutDigest,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    planDigest: hash(stableJson(planCore(withoutDigest))),
  };
}
