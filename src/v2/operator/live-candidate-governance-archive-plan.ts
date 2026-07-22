import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1 } from "../application/candidate-content-quality-review.js";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const PRIOR_TARGET_ROWS = 24;
const APPENDED_TARGET_ROWS = 88;
export const GOVERNANCE_ARCHIVE_TARGET_ROWS = PRIOR_TARGET_ROWS + APPENDED_TARGET_ROWS;

export type CandidateGovernanceArchiveReasonV1 =
  | "covered_by_canonical_policy"
  | "semantic_redundancy"
  | "transient_conversation"
  | "volatile_runtime_snapshot"
  | "capture_unsafe_automatic_trace"
  | "transient_reflection_summary"
  | "operational_checkpoint_noise"
  | "obsolete_cross_instance_policy"
  | "reflection_event_trace";

interface CandidateRowV1 {
  item_id: string;
  current_revision_id: string;
  revision_no: number;
  content: string;
  category: string;
  address_json: string;
  tenant_id: string;
  principal_id: string;
  agent_id: string;
  visibility: string;
  retention: string;
  workspace_id: string | null;
  project_id: string | null;
  conversation_id: string | null;
  thread_id: string | null;
  customer_id: string | null;
  task_id: string | null;
  lifecycle: "candidate";
  verification: "unverified";
  valid_until: string | null;
  source_id: string;
  source_type: string;
  external_id: string | null;
  observed_at: string;
  evidence_json: string;
}

interface PriorAdjudicationRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  sourceLineageReceiptDigest: string;
  category: string;
  sourceLane: string;
  disposition: "propose_soft_archive" | "retain_for_verification";
  basis: "covered_by_canonical_policy" | "semantic_redundancy" | "transient_conversation" | "volatile_runtime_snapshot";
  evidenceDigest: string;
  proposedNextAction: string;
  mutationReady: false;
  proposedLifecycle: "candidate";
  proposedVerification: "unverified";
}

interface PriorAdjudicationPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-post-rewrite-adjudication-plan";
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  mutationReadyRows: 0;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresSeparateExactApply: true;
  proposedAdjudicationId: string;
  contentQualityPlanDigest: string;
  contentQualityPreviewSha256: string;
  rewritePlanDigest: string;
  rewritePlanSha256: string;
  rewriteApplyReceiptSha256: string;
  rewritePostcheckSha256: string;
  decisionControlDigest: string;
  decisionControlSha256: string;
  source: CompanionDispositionSourceV1;
  rewriteClosure: Record<string, number>;
  summary: Record<string, number>;
  rows: PriorAdjudicationRowV1[];
  planDigest: string;
}

export interface AppendedCandidateArchiveDecisionRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  category: string;
  classification: "reflection_summary" | "operational_checkpoint" | "explicit_manual" | "unknown_legacy";
  sourceEvidenceDigest: string;
  captureSafetyAllowed: boolean;
  captureSafetyReason?: string;
  reason: Extract<CandidateGovernanceArchiveReasonV1,
    "capture_unsafe_automatic_trace" | "transient_reflection_summary" | "operational_checkpoint_noise"
    | "obsolete_cross_instance_policy" | "reflection_event_trace">;
  disposition: "propose_soft_archive";
  proposedNextAction: "soft_archive_under_separate_exact_apply";
  mutationReady: false;
  proposedLifecycle: "candidate";
  proposedVerification: "unverified";
  reviewEvidenceDigest: string;
}

export interface AppendedCandidateArchiveDecisionControlV1 {
  schemaVersion: 1;
  phase: "clawlore-appended-candidate-archive-operator-decisions";
  createdAt: string;
  decisionId: string;
  sourceRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  authorizesSoftArchive: false;
  authorizesLifecycleMutation: false;
  requiresSeparateExactApply: true;
  source: CompanionDispositionSourceV1;
  sourceLogicalDigest: string;
  summary: {
    reviewedRows: 88;
    proposedSoftArchiveRows: 88;
    reflectionSummaryRows: 66;
    operationalCheckpointRows: 20;
    explicitManualRows: 1;
    unknownLegacyRows: 1;
    captureSafetyRejectedRows: number;
    captureSafetyAllowedRows: number;
    mutationReadyRows: 0;
  };
  rows: AppendedCandidateArchiveDecisionRowV1[];
  decisionDigest: string;
}

export interface CandidateGovernanceArchiveBindingRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  category: string;
  addressDigest: string;
  principalBindingDigest: string;
  aclDigest: string;
  sourceEvidenceDigest: string;
  origin: "prior_adjudication" | "appended_delta_review";
  classification: string;
  reason: CandidateGovernanceArchiveReasonV1;
  decisionEvidenceDigest: string;
  disposition: "soft_archive";
}

export interface LiveCandidateGovernanceArchivePlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-governance-soft-archive-plan";
  createdAt: string;
  proposedArchiveId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  targetRows: 112;
  mutationReadyRows: 0;
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
  priorAdjudicationPlanDigest: string;
  priorAdjudicationPlanSha256: string;
  appendedDecisionDigest: string;
  appendedDecisionSha256: string;
  source: CompanionDispositionSourceV1;
  sourceLogicalDigest: string;
  summary: {
    targetRows: 112;
    priorAdjudicationRows: 24;
    appendedDeltaRows: 88;
    reasonCounts: Record<CandidateGovernanceArchiveReasonV1, number>;
    liveBindingMismatches: 0;
    mutationReadyRows: 0;
  };
  rows: CandidateGovernanceArchiveBindingRowV1[];
  planDigest: string;
}

export interface LiveCandidateGovernanceArchiveAcceptanceV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-governance-soft-archive-acceptance";
  acceptedAt: string;
  status: "pass";
  planDigest: string;
  planSha256: string;
  source: CompanionDispositionSourceV1;
  sourceLogicalDigest: string;
  summary: LiveCandidateGovernanceArchivePlanV1["summary"];
  liveBindingMismatches: 0;
  rawTraceOrIdentifierLeak: false;
  authorizesSoftArchive: false;
  authorizesLifecycleMutation: false;
  requiresFreshEncryptedSnapshot: true;
  requiresSeparateExactApply: true;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("candidate governance control must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("candidate governance control JSON is invalid");
  }
  return { value, sha256: hash(bytes) };
}

function digestQuery(db: DatabaseSync, sql: string): string {
  return hash(JSON.stringify(db.prepare(sql).all()));
}

/** A content-bearing state hash used only as a drift fence; no source data is emitted. */
export function candidateGovernanceSourceLogicalDigestV1(db: DatabaseSync): string {
  return hash(JSON.stringify([
    digestQuery(db, "SELECT * FROM memory_truth ORDER BY id"),
    digestQuery(db, "SELECT * FROM memory_items ORDER BY item_id"),
    digestQuery(db, "SELECT * FROM memory_revisions ORDER BY item_id,revision_no,revision_id"),
    digestQuery(db, "SELECT * FROM memory_sources ORDER BY revision_id,source_id"),
    digestQuery(db, "SELECT * FROM memory_acl ORDER BY item_id,acl_id"),
    digestQuery(db, "SELECT * FROM memory_fts_compat_v2 ORDER BY item_id"),
    digestQuery(db, "SELECT * FROM memory_fts_v2 ORDER BY item_id"),
    digestQuery(db, "SELECT * FROM memory_vector_projection_v2 ORDER BY item_id"),
    digestQuery(db, "SELECT * FROM memory_relation_projection_v2 ORDER BY item_id"),
    digestQuery(db, "SELECT * FROM projection_outbox ORDER BY outbox_id"),
  ]));
}

function candidateRows(db: DatabaseSync): CandidateRowV1[] {
  return db.prepare(`SELECT i.item_id,i.current_revision_id,i.revision_no,i.content,i.category,i.address_json,
    i.tenant_id,i.principal_id,i.agent_id,i.visibility,i.retention,i.workspace_id,i.project_id,
    i.conversation_id,i.thread_id,i.customer_id,i.task_id,i.lifecycle,i.verification,i.valid_until,
    s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateRowV1[];
}

function aclDigest(db: DatabaseSync, itemId: string): string {
  return hash(JSON.stringify(db.prepare("SELECT * FROM memory_acl WHERE item_id=? ORDER BY acl_id").all(itemId)));
}

function principalBindingDigest(row: CandidateRowV1): string {
  return hash(JSON.stringify({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    visibility: row.visibility,
    retention: row.retention,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    customerId: row.customer_id,
    taskId: row.task_id,
  }));
}

function liveBinding(db: DatabaseSync, row: CandidateRowV1, input: {
  origin: CandidateGovernanceArchiveBindingRowV1["origin"];
  classification: string;
  reason: CandidateGovernanceArchiveReasonV1;
  decisionEvidenceDigest: string;
}): CandidateGovernanceArchiveBindingRowV1 {
  return {
    itemIdSha256: hash(row.item_id),
    currentRevisionIdSha256: hash(row.current_revision_id),
    contentDigest: hash(row.content),
    normalizedContentDigest: hash(normalizeCandidateContentV1(row.content)),
    category: row.category,
    addressDigest: hash(row.address_json),
    principalBindingDigest: principalBindingDigest(row),
    aclDigest: aclDigest(db, row.item_id),
    sourceEvidenceDigest: hash(row.evidence_json),
    ...input,
    disposition: "soft_archive",
  };
}

function validatePriorPlan(value: PriorAdjudicationPlanV1): PriorAdjudicationPlanV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-post-rewrite-adjudication-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.emitsContentDigests !== true
    || value.mutationReadyRows !== 0
    || value.authorizesSoftArchive !== false
    || value.authorizesLifecycleMutation !== false
    || value.requiresSeparateExactApply !== true
    || !Array.isArray(value.rows)
    || !isDigest(value.planDigest)
  ) throw new Error("prior candidate adjudication plan is invalid or authorizing");
  const core = {
    proposedAdjudicationId: value.proposedAdjudicationId,
    contentQualityPlanDigest: value.contentQualityPlanDigest,
    contentQualityPreviewSha256: value.contentQualityPreviewSha256,
    rewritePlanDigest: value.rewritePlanDigest,
    rewritePlanSha256: value.rewritePlanSha256,
    rewriteApplyReceiptSha256: value.rewriteApplyReceiptSha256,
    rewritePostcheckSha256: value.rewritePostcheckSha256,
    decisionControlDigest: value.decisionControlDigest,
    decisionControlSha256: value.decisionControlSha256,
    source: value.source,
    rewriteClosure: value.rewriteClosure,
    summary: value.summary,
    rows: value.rows,
  };
  if (hash(JSON.stringify(core)) !== value.planDigest) throw new Error("prior candidate adjudication digest is invalid");
  const targets = value.rows.filter((row) => row.disposition === "propose_soft_archive");
  if (targets.length !== PRIOR_TARGET_ROWS || new Set(targets.map((row) => row.itemIdSha256)).size !== PRIOR_TARGET_ROWS) {
    throw new Error("prior candidate adjudication is not the exact 24-row archive lane");
  }
  return value;
}

function decisionCore(value: AppendedCandidateArchiveDecisionControlV1): unknown {
  return {
    decisionId: value.decisionId,
    sourceRolloutId: value.sourceRolloutId,
    source: value.source,
    sourceLogicalDigest: value.sourceLogicalDigest,
    summary: value.summary,
    rows: value.rows,
  };
}

export function validateAppendedCandidateArchiveDecisionControlV1(
  value: AppendedCandidateArchiveDecisionControlV1,
): AppendedCandidateArchiveDecisionControlV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-appended-candidate-archive-operator-decisions"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.emitsContentDigests !== true
    || value.authorizesSoftArchive !== false
    || value.authorizesLifecycleMutation !== false
    || value.requiresSeparateExactApply !== true
    || value.summary.reviewedRows !== APPENDED_TARGET_ROWS
    || value.summary.proposedSoftArchiveRows !== APPENDED_TARGET_ROWS
    || value.summary.reflectionSummaryRows !== 66
    || value.summary.operationalCheckpointRows !== 20
    || value.summary.explicitManualRows !== 1
    || value.summary.unknownLegacyRows !== 1
    || value.summary.mutationReadyRows !== 0
    || !Array.isArray(value.rows)
    || value.rows.length !== APPENDED_TARGET_ROWS
    || new Set(value.rows.map((row) => row.itemIdSha256)).size !== APPENDED_TARGET_ROWS
    || value.rows.some((row) => row.disposition !== "propose_soft_archive"
      || row.proposedNextAction !== "soft_archive_under_separate_exact_apply"
      || row.mutationReady !== false
      || row.proposedLifecycle !== "candidate"
      || row.proposedVerification !== "unverified")
    || !isDigest(value.sourceLogicalDigest)
    || !isDigest(value.decisionDigest)
    || hash(JSON.stringify(decisionCore(value))) !== value.decisionDigest
  ) throw new Error("appended candidate archive decisions are invalid or authorizing");
  return value;
}

function expectedExtendedSource(prior: CompanionDispositionSourceV1): CompanionDispositionSourceV1 {
  return {
    ...prior,
    v1Rows: prior.v1Rows + APPENDED_TARGET_ROWS,
    v2Rows: prior.v2Rows + APPENDED_TARGET_ROWS,
    candidateRows: prior.candidateRows + APPENDED_TARGET_ROWS,
    compatibilityRows: prior.compatibilityRows + APPENDED_TARGET_ROWS,
    currentFtsRows: prior.currentFtsRows + APPENDED_TARGET_ROWS,
    vectorRows: prior.vectorRows + APPENDED_TARGET_ROWS,
    relationRows: prior.relationRows + APPENDED_TARGET_ROWS,
  };
}

function planCore(value: LiveCandidateGovernanceArchivePlanV1): unknown {
  return {
    proposedArchiveId: value.proposedArchiveId,
    priorAdjudicationPlanDigest: value.priorAdjudicationPlanDigest,
    priorAdjudicationPlanSha256: value.priorAdjudicationPlanSha256,
    appendedDecisionDigest: value.appendedDecisionDigest,
    appendedDecisionSha256: value.appendedDecisionSha256,
    source: value.source,
    sourceLogicalDigest: value.sourceLogicalDigest,
    summary: value.summary,
    rows: value.rows,
  };
}

export function validateLiveCandidateGovernanceArchivePlanV1(
  value: LiveCandidateGovernanceArchivePlanV1,
  expectedDigest?: string,
): LiveCandidateGovernanceArchivePlanV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-governance-soft-archive-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.emitsContentDigests !== true
    || value.targetRows !== GOVERNANCE_ARCHIVE_TARGET_ROWS
    || value.mutationReadyRows !== 0
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
    || value.summary.targetRows !== GOVERNANCE_ARCHIVE_TARGET_ROWS
    || value.summary.priorAdjudicationRows !== PRIOR_TARGET_ROWS
    || value.summary.appendedDeltaRows !== APPENDED_TARGET_ROWS
    || value.summary.liveBindingMismatches !== 0
    || value.summary.mutationReadyRows !== 0
    || !Array.isArray(value.rows)
    || value.rows.length !== GOVERNANCE_ARCHIVE_TARGET_ROWS
    || new Set(value.rows.map((row) => row.itemIdSha256)).size !== GOVERNANCE_ARCHIVE_TARGET_ROWS
    || value.rows.some((row) => row.disposition !== "soft_archive")
    || !isDigest(value.sourceLogicalDigest)
    || !isDigest(value.planDigest)
    || (expectedDigest && value.planDigest !== expectedDigest)
    || hash(JSON.stringify(planCore(value))) !== value.planDigest
  ) throw new Error("candidate governance archive plan is invalid or authorizing");
  return value;
}

export function assertCandidateGovernanceLiveBindingV1(
  db: DatabaseSync,
  planned: CandidateGovernanceArchiveBindingRowV1,
  row: CandidateRowV1,
): void {
  if (
    row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
    || hash(row.address_json) !== planned.addressDigest
    || principalBindingDigest(row) !== planned.principalBindingDigest
    || aclDigest(db, row.item_id) !== planned.aclDigest
    || hash(row.evidence_json) !== planned.sourceEvidenceDigest
  ) throw new Error("candidate governance archive live target no longer matches the reviewed binding");
}

export function candidateGovernanceRowsByHashV1(db: DatabaseSync): Map<string, CandidateRowV1> {
  return new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
}

function validateCurrentPlanBindings(db: DatabaseSync, plan: LiveCandidateGovernanceArchivePlanV1): void {
  if (!sameCompanionDispositionSourceV1(companionDispositionSourceStateV1(db), plan.source)
    || candidateGovernanceSourceLogicalDigestV1(db) !== plan.sourceLogicalDigest) {
    throw new Error("live source no longer matches the candidate governance archive plan");
  }
  const byHash = candidateGovernanceRowsByHashV1(db);
  for (const planned of plan.rows) {
    const row = byHash.get(planned.itemIdSha256);
    if (!row) throw new Error("candidate governance archive target mapping is incomplete");
    assertCandidateGovernanceLiveBindingV1(db, planned, row);
  }
}

export function createLiveCandidateGovernanceArchivePlanV1(input: {
  sourcePath: string;
  priorAdjudicationPath: string;
  appendedDecisionPath: string;
  proposedArchiveId: string;
  now?: () => Date;
}): LiveCandidateGovernanceArchivePlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedArchiveId)) {
    throw new Error("candidate governance archive id is invalid");
  }
  const priorLoaded = privateJson<PriorAdjudicationPlanV1>(input.priorAdjudicationPath);
  const prior = validatePriorPlan(priorLoaded.value);
  const decisionLoaded = privateJson<AppendedCandidateArchiveDecisionControlV1>(input.appendedDecisionPath);
  const decisions = validateAppendedCandidateArchiveDecisionControlV1(decisionLoaded.value);
  if (!sameCompanionDispositionSourceV1(decisions.source, expectedExtendedSource(prior.source))) {
    throw new Error("current source is not the exact 88-row append-only extension of the prior adjudication source");
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const source = companionDispositionSourceStateV1(db);
    const sourceLogicalDigest = candidateGovernanceSourceLogicalDigestV1(db);
    if (!sameCompanionDispositionSourceV1(source, decisions.source)
      || sourceLogicalDigest !== decisions.sourceLogicalDigest) {
      throw new Error("live source no longer matches appended candidate decisions");
    }
    const byHash = candidateGovernanceRowsByHashV1(db);
    const priorRows = prior.rows.filter((row) => row.disposition === "propose_soft_archive").map((row) => {
      const live = byHash.get(row.itemIdSha256);
      if (!live
        || hash(live.current_revision_id) !== row.currentRevisionIdSha256
        || hash(live.content) !== row.contentDigest
        || hash(normalizeCandidateContentV1(live.content)) !== row.normalizedContentDigest
        || live.category !== row.category) {
        throw new Error("prior adjudication archive target drifted before combined planning");
      }
      return liveBinding(db, live, {
        origin: "prior_adjudication",
        classification: row.sourceLane,
        reason: row.basis,
        decisionEvidenceDigest: row.evidenceDigest,
      });
    });
    const decisionRows = decisions.rows.map((row) => {
      const live = byHash.get(row.itemIdSha256);
      if (!live
        || hash(live.current_revision_id) !== row.currentRevisionIdSha256
        || hash(live.content) !== row.contentDigest
        || hash(normalizeCandidateContentV1(live.content)) !== row.normalizedContentDigest
        || live.category !== row.category
        || hash(live.evidence_json) !== row.sourceEvidenceDigest) {
        throw new Error("appended candidate archive target drifted before combined planning");
      }
      return liveBinding(db, live, {
        origin: "appended_delta_review",
        classification: row.classification,
        reason: row.reason,
        decisionEvidenceDigest: row.reviewEvidenceDigest,
      });
    });
    const rows = [...priorRows, ...decisionRows].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    if (rows.length !== GOVERNANCE_ARCHIVE_TARGET_ROWS
      || new Set(rows.map((row) => row.itemIdSha256)).size !== GOVERNANCE_ARCHIVE_TARGET_ROWS) {
      throw new Error("combined candidate governance target set is not exactly 112 unique rows");
    }
    const reasons: CandidateGovernanceArchiveReasonV1[] = [
      "covered_by_canonical_policy", "semantic_redundancy", "transient_conversation", "volatile_runtime_snapshot",
      "capture_unsafe_automatic_trace", "transient_reflection_summary", "operational_checkpoint_noise",
      "obsolete_cross_instance_policy", "reflection_event_trace",
    ];
    const reasonCounts = Object.fromEntries(
      reasons.map((reason) => [reason, rows.filter((row) => row.reason === reason).length]),
    ) as Record<CandidateGovernanceArchiveReasonV1, number>;
    const summary: LiveCandidateGovernanceArchivePlanV1["summary"] = {
      targetRows: 112,
      priorAdjudicationRows: 24,
      appendedDeltaRows: 88,
      reasonCounts,
      liveBindingMismatches: 0,
      mutationReadyRows: 0,
    };
    const partial = {
      schemaVersion: 1 as const,
      phase: "clawlore-candidate-governance-soft-archive-plan" as const,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      proposedArchiveId: input.proposedArchiveId,
      readOnly: true as const,
      queryOnly: true as const,
      emitsMemoryContent: false as const,
      emitsTranscriptContent: false as const,
      emitsRawIdentifiers: false as const,
      emitsContentDigests: true as const,
      targetRows: 112 as const,
      mutationReadyRows: 0 as const,
      authorizesContentRewrite: false as const,
      authorizesSoftArchive: false as const,
      authorizesHardDelete: false as const,
      authorizesLifecycleMutation: false as const,
      authorizesVerificationMutation: false as const,
      authorizesContextEngine: false as const,
      authorizesPromptMutation: false as const,
      authorizesFinalRecall: false as const,
      requiresFreshEncryptedSnapshot: true as const,
      requiresSeparateExactApply: true as const,
      priorAdjudicationPlanDigest: prior.planDigest,
      priorAdjudicationPlanSha256: priorLoaded.sha256,
      appendedDecisionDigest: decisions.decisionDigest,
      appendedDecisionSha256: decisionLoaded.sha256,
      source,
      sourceLogicalDigest,
      summary,
      rows,
    };
    return { ...partial, planDigest: hash(JSON.stringify(planCore(partial as LiveCandidateGovernanceArchivePlanV1))) };
  } finally {
    db.close();
  }
}

export function acceptLiveCandidateGovernanceArchivePlanV1(input: {
  sourcePath: string;
  planPath: string;
  planDigest: string;
  now?: () => Date;
}): LiveCandidateGovernanceArchiveAcceptanceV1 {
  const loaded = privateJson<LiveCandidateGovernanceArchivePlanV1>(input.planPath);
  const plan = validateLiveCandidateGovernanceArchivePlanV1(loaded.value, input.planDigest);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    validateCurrentPlanBindings(db, plan);
  } finally {
    db.close();
  }
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-governance-soft-archive-acceptance",
    acceptedAt: (input.now ?? (() => new Date()))().toISOString(),
    status: "pass",
    planDigest: plan.planDigest,
    planSha256: loaded.sha256,
    source: plan.source,
    sourceLogicalDigest: plan.sourceLogicalDigest,
    summary: plan.summary,
    liveBindingMismatches: 0,
    rawTraceOrIdentifierLeak: false,
    authorizesSoftArchive: false,
    authorizesLifecycleMutation: false,
    requiresFreshEncryptedSnapshot: true,
    requiresSeparateExactApply: true,
  };
}

export function loadPrivateCandidateGovernanceControlV1<T>(path: string): { value: T; sha256: string } {
  return privateJson<T>(path);
}
