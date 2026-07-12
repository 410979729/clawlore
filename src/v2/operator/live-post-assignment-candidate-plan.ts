import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { MemoryAddressV2 } from "../domain/memory-address.js";
import type { MemoryLifecycleV2, MemoryVerificationV2 } from "../domain/memory-record.js";
import {
  planCandidatePromotionsV1,
  type CandidateAttributionEvidenceV1,
  type CandidatePromotionReviewRowV1,
  type LegacyCandidateClassificationV1,
} from "../application/candidate-promotion-policy.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

type AssignmentDecision =
  | "propose_private_principal_evidence_assignment"
  | "propose_conversation_boundary_evidence_assignment"
  | "keep_candidate_unassigned"
  | "await_external_source_receipt"
  | "retain_quarantine";

interface AssignmentPlanRowV1 {
  itemIdSha256: string;
  currentStateDigest: string;
  lane: string;
  decision: AssignmentDecision;
  resolver?: string;
  resolverEvidenceDigest?: string;
  proposedEvidencePayloadDigest?: string;
  postLifecycle: "candidate";
  postVerification: string;
  lifecycleMutationAllowed: false;
}

interface AssignmentPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-evidence-assignment-plan";
  proposedRolloutId: string;
  planDigest: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  automaticPromotionRows: 0;
  authorizesEvidenceWrite: false;
  authorizesLifecycleMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  remediationPlanDigest: string;
  remediationPreviewSha256: string;
  sessionsRegistrySha256: string;
  source: {
    v1Rows: number;
    v2Rows: number;
    candidateRows: number;
    activeRows: number;
    archivedRows: number;
    compatibilityRows: number;
    pendingOutboxRows: number;
  };
  summary: {
    proposedEvidenceAssignmentRows: number;
    explicitHoldRows: number;
    quarantineRows: number;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
  };
  decisions: Record<AssignmentDecision, number>;
  rows: AssignmentPlanRowV1[];
}

interface AssignmentAcceptanceV1 {
  schemaVersion: 1;
  phase: "clawlore-v2-live-evidence-assignment";
  rolloutId: string;
  status: "applied";
  appliedAt: string;
  planDigest: string;
  planSha256: string;
  source: { memoryTruthRows: number; memoryTruthLogicalDigest: string; unchanged: true };
  evidence: {
    rowsWritten: number;
    directPrincipalRows: number;
    conversationBoundaryRows: number;
    manualRowsChanged: 0;
    externalSourceReceiptRowsChanged: 0;
    quarantineRowsChanged: 0;
    nonTargetEvidenceRowsChanged: 0;
  };
  canonical: {
    memoryItemRowsChanged: 0;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
    addressRowsChanged: 0;
    pendingOutboxRowsChanged: 0;
    compatibilityRowsChanged: 0;
  };
  database: { integrity: "ok"; foreignKeyViolations: 0 };
  runtime: {
    v1FallbackReads: true;
    lifecycleMutationEnabled: false;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

interface RegistryResolvedEvidenceV1 {
  schemaVersion: 1;
  rolloutId: string;
  planDigest: string;
  evidenceKind: "direct-principal" | "conversation-boundary";
  resolver: string;
  resolverEvidenceDigest: string;
  currentStateDigest: string;
  proposedEvidencePayloadDigest: string;
  assignedAt: string;
  preservesLifecycle: true;
  preservesVerification: true;
}

interface CandidateSourceRow {
  item_id: string;
  current_revision_id: string;
  address_json: string;
  lifecycle: string;
  verification: string;
  source_id: string;
  evidence_json: string;
}

export interface LivePostAssignmentCandidatePlanReceiptV1 {
  schemaVersion: 1;
  phase: "clawlore-post-assignment-candidate-plan";
  createdAt: string;
  proposedRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  assignment: {
    rolloutId: string;
    planDigest: string;
    planSha256: string;
    acceptanceSha256: string;
    rowsValidated: number;
    directPrincipalRows: number;
    conversationBoundaryRows: number;
    invalidEvidenceRows: 0;
    unplannedEvidenceRows: 0;
  };
  source: AssignmentPlanV1["source"] & {
    baselineV1Rows: number;
    unmirroredV1Rows: number;
    missingLegacyRowsForV2: 0;
    candidateBaselineUnchanged: true;
    sourceUnchangedDuringPlan: true;
  };
  candidatePromotionPlan: ReturnType<typeof planCandidatePromotionsV1>;
  decision: {
    eligibleRows: number;
    lifecycleRolloutSelectable: boolean;
    finalRecallCutoverBlockedByUnmirroredV1: boolean;
    automaticPromotionRows: 0;
    requiresSeparateExactApproval: true;
  };
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

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("candidate-plan control must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("candidate-plan control JSON is invalid");
  }
  return { value, sha256: hash(bytes) };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("candidate source evidence is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function planCore(plan: AssignmentPlanV1): Record<string, unknown> {
  return {
    proposedRolloutId: plan.proposedRolloutId,
    remediationPlanDigest: plan.remediationPlanDigest,
    remediationPreviewSha256: plan.remediationPreviewSha256,
    sessionsRegistrySha256: plan.sessionsRegistrySha256,
    source: plan.source,
    summary: plan.summary,
    decisions: plan.decisions,
    rows: plan.rows,
  };
}

function loadControls(planPath: string, acceptancePath: string): {
  plan: AssignmentPlanV1;
  acceptance: AssignmentAcceptanceV1;
  planSha256: string;
  acceptanceSha256: string;
} {
  const loadedPlan = privateJson<AssignmentPlanV1>(planPath);
  const loadedAcceptance = privateJson<AssignmentAcceptanceV1>(acceptancePath);
  const plan = loadedPlan.value;
  const acceptance = loadedAcceptance.value;
  if (
    plan.schemaVersion !== 1
    || plan.phase !== "clawlore-evidence-assignment-plan"
    || plan.readOnly !== true
    || plan.queryOnly !== true
    || plan.emitsMemoryContent !== false
    || plan.emitsTranscriptContent !== false
    || plan.emitsRawIdentifiers !== false
    || plan.automaticPromotionRows !== 0
    || plan.authorizesEvidenceWrite !== false
    || plan.authorizesLifecycleMutation !== false
    || plan.authorizesContextEngine !== false
    || plan.authorizesPromptMutation !== false
    || plan.authorizesFinalRecall !== false
    || !hasDigest(plan.planDigest)
    || hash(JSON.stringify(planCore(plan))) !== plan.planDigest
    || plan.rows.length !== plan.source.candidateRows
  ) throw new Error("evidence-assignment plan contract is invalid");
  if (
    acceptance.schemaVersion !== 1
    || acceptance.phase !== "clawlore-v2-live-evidence-assignment"
    || acceptance.status !== "applied"
    || acceptance.rolloutId !== plan.proposedRolloutId
    || acceptance.planDigest !== plan.planDigest
    || acceptance.planSha256 !== loadedPlan.sha256
    || acceptance.source.unchanged !== true
    || acceptance.evidence.rowsWritten !== plan.summary.proposedEvidenceAssignmentRows
    || acceptance.evidence.directPrincipalRows !== plan.decisions.propose_private_principal_evidence_assignment
    || acceptance.evidence.conversationBoundaryRows !== plan.decisions.propose_conversation_boundary_evidence_assignment
    || acceptance.evidence.manualRowsChanged !== 0
    || acceptance.evidence.externalSourceReceiptRowsChanged !== 0
    || acceptance.evidence.quarantineRowsChanged !== 0
    || acceptance.evidence.nonTargetEvidenceRowsChanged !== 0
    || acceptance.canonical.lifecycleRowsChanged !== 0
    || acceptance.canonical.verificationRowsChanged !== 0
    || acceptance.canonical.addressRowsChanged !== 0
    || acceptance.database.integrity !== "ok"
    || acceptance.database.foreignKeyViolations !== 0
    || acceptance.runtime.v1FallbackReads !== true
    || acceptance.runtime.lifecycleMutationEnabled !== false
    || acceptance.runtime.contextEngineEnabled !== false
    || acceptance.runtime.promptMutationEnabled !== false
    || acceptance.runtime.finalRecallCutoverEnabled !== false
  ) throw new Error("evidence-assignment acceptance contract is invalid or unbound");
  return {
    plan,
    acceptance,
    planSha256: loadedPlan.sha256,
    acceptanceSha256: loadedAcceptance.sha256,
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

function classification(value: unknown): LegacyCandidateClassificationV1 {
  return [
    "explicit_manual", "reflection_summary", "task_experience",
    "operational_checkpoint", "auto_capture", "unknown_legacy",
  ].includes(String(value)) ? value as LegacyCandidateClassificationV1 : "unknown_legacy";
}

function exactRegistryEvidence(
  value: unknown,
  plan: AssignmentPlanV1,
  row: AssignmentPlanRowV1,
): RegistryResolvedEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("planned registry-resolved evidence is missing");
  }
  const evidence = value as Record<string, unknown>;
  const expectedKeys = [
    "assignedAt", "currentStateDigest", "evidenceKind", "planDigest", "preservesLifecycle",
    "preservesVerification", "proposedEvidencePayloadDigest", "resolver", "resolverEvidenceDigest",
    "rolloutId", "schemaVersion",
  ].sort();
  if (JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("registry-resolved evidence shape is invalid");
  }
  const expectedKind = row.decision === "propose_private_principal_evidence_assignment"
    ? "direct-principal"
    : "conversation-boundary";
  if (
    evidence.schemaVersion !== 1
    || evidence.rolloutId !== plan.proposedRolloutId
    || evidence.planDigest !== plan.planDigest
    || evidence.evidenceKind !== expectedKind
    || evidence.resolver !== row.resolver
    || evidence.resolverEvidenceDigest !== row.resolverEvidenceDigest
    || evidence.currentStateDigest !== row.currentStateDigest
    || evidence.proposedEvidencePayloadDigest !== row.proposedEvidencePayloadDigest
    || evidence.preservesLifecycle !== true
    || evidence.preservesVerification !== true
    || !Number.isFinite(Date.parse(String(evidence.assignedAt ?? "")))
  ) throw new Error("registry-resolved evidence does not match the approved plan");
  return evidence as unknown as RegistryResolvedEvidenceV1;
}

function reviewRow(
  row: CandidateSourceRow,
  source: Record<string, unknown>,
  registryEvidence?: RegistryResolvedEvidenceV1,
): CandidatePromotionReviewRowV1 {
  const address = JSON.parse(row.address_json) as MemoryAddressV2;
  const kind = classification(source.classification);
  let attribution: CandidateAttributionEvidenceV1 = "none";
  const evidence: CandidatePromotionReviewRowV1["evidence"] = { sourceReceiptCount: 0 };
  if (registryEvidence?.evidenceKind === "direct-principal") {
    attribution = "registry_direct";
    evidence.identityEvidenceDigest = registryEvidence.resolverEvidenceDigest;
  } else if (registryEvidence?.evidenceKind === "conversation-boundary") {
    attribution = "registry_conversation";
    evidence.boundaryEvidenceDigest = registryEvidence.resolverEvidenceDigest;
  } else if (kind === "unknown_legacy") {
    attribution = "opaque";
  } else if (address.visibility === "private" && address.principalId !== "legacy:unresolved") {
    attribution = "runtime_principal";
    evidence.identityEvidenceDigest = hash(JSON.stringify({
      principalId: address.principalId,
      platform: address.platform ?? "",
      accountId: address.accountId ?? "",
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

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function liveSourceSummary(db: DatabaseSync): AssignmentPlanV1["source"] {
  return {
    v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
    v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
    candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    compatibilityRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2"),
    pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
  };
}

function candidateStateDigest(rows: CandidateSourceRow[]): string {
  return hash(JSON.stringify(rows.map((row) => ({
    itemId: row.item_id,
    currentRevisionId: row.current_revision_id,
    addressJson: row.address_json,
    lifecycle: row.lifecycle,
    verification: row.verification,
    sourceId: row.source_id,
    evidenceJson: row.evidence_json,
  }))));
}

function candidateBaselineMatches(
  live: AssignmentPlanV1["source"],
  baseline: AssignmentPlanV1["source"],
): boolean {
  return live.v1Rows >= baseline.v1Rows
    && live.v2Rows === baseline.v2Rows
    && live.candidateRows === baseline.candidateRows
    && live.activeRows === baseline.activeRows
    && live.archivedRows === baseline.archivedRows
    && live.compatibilityRows === baseline.compatibilityRows
    && live.pendingOutboxRows === baseline.pendingOutboxRows;
}

export function createLivePostAssignmentCandidatePlanV1(input: {
  sourcePath: string;
  assignmentPlanPath: string;
  assignmentAcceptancePath: string;
  proposedRolloutId: string;
  now?: () => Date;
}): LivePostAssignmentCandidatePlanReceiptV1 {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
    throw new Error("proposed candidate rollout id is invalid");
  }
  const controls = loadControls(input.assignmentPlanPath, input.assignmentAcceptancePath);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  let summary: AssignmentPlanV1["source"];
  let rows: CandidateSourceRow[];
  let promotion: ReturnType<typeof planCandidatePromotionsV1>;
  let directPrincipalRows = 0;
  let conversationBoundaryRows = 0;
  let unmirroredV1Rows = 0;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    summary = liveSourceSummary(db);
    unmirroredV1Rows = scalar(db, `SELECT COUNT(*) FROM memory_truth l
      LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`);
    const missingLegacyRowsForV2 = scalar(db, `SELECT COUNT(*) FROM memory_items i
      LEFT JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
    rows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      s.source_id,s.evidence_json FROM memory_items i JOIN memory_sources s
      ON s.revision_id=i.current_revision_id WHERE i.lifecycle='candidate'
      ORDER BY i.item_id,s.source_id`).all() as CandidateSourceRow[];
    const beforeDigest = candidateStateDigest(rows);
    const planned = new Map(controls.plan.rows.map((row) => [row.itemIdSha256, row]));
    if (
      !candidateBaselineMatches(summary, controls.plan.source)
      || missingLegacyRowsForV2 !== 0
      || rows.length !== controls.plan.source.candidateRows
      || planned.size !== rows.length
      || rows.some((row) => !planned.has(hash(row.item_id)))
    ) throw new Error("live candidate set no longer matches the evidence-assignment baseline");
    const reviewRows = rows.map((row) => {
      const plannedRow = planned.get(hash(row.item_id));
      if (!plannedRow || plannedRow.currentStateDigest !== stableStateDigest(row)) {
        throw new Error("live candidate state no longer matches the evidence-assignment baseline");
      }
      const source = parseRecord(row.evidence_json);
      const assigned = source.registryResolvedEvidenceV1;
      const isTarget = plannedRow.decision.startsWith("propose_");
      if (!isTarget && assigned !== undefined) throw new Error("unplanned registry-resolved evidence exists");
      let registryEvidence: RegistryResolvedEvidenceV1 | undefined;
      if (isTarget) {
        registryEvidence = exactRegistryEvidence(assigned, controls.plan, plannedRow);
        if (registryEvidence.evidenceKind === "direct-principal") directPrincipalRows += 1;
        else conversationBoundaryRows += 1;
      }
      return reviewRow(row, source, registryEvidence);
    });
    if (
      directPrincipalRows !== controls.acceptance.evidence.directPrincipalRows
      || conversationBoundaryRows !== controls.acceptance.evidence.conversationBoundaryRows
      || directPrincipalRows + conversationBoundaryRows !== controls.acceptance.evidence.rowsWritten
    ) throw new Error("validated evidence-assignment counts do not match acceptance");
    promotion = planCandidatePromotionsV1(reviewRows);
    const afterRows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      s.source_id,s.evidence_json FROM memory_items i JOIN memory_sources s
      ON s.revision_id=i.current_revision_id WHERE i.lifecycle='candidate'
      ORDER BY i.item_id,s.source_id`).all() as CandidateSourceRow[];
    if (
      beforeDigest !== candidateStateDigest(afterRows)
      || JSON.stringify(summary) !== JSON.stringify(liveSourceSummary(db))
      || unmirroredV1Rows !== scalar(db, `SELECT COUNT(*) FROM memory_truth l
        LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`)
    ) throw new Error("live candidate state changed during query-only planning");
  } finally {
    db.close();
  }
  const eligibleRows = promotion.counts.eligible_for_operator_promotion;
  return {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    proposedRolloutId: input.proposedRolloutId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    assignment: {
      rolloutId: controls.acceptance.rolloutId,
      planDigest: controls.plan.planDigest,
      planSha256: controls.planSha256,
      acceptanceSha256: controls.acceptanceSha256,
      rowsValidated: directPrincipalRows + conversationBoundaryRows,
      directPrincipalRows,
      conversationBoundaryRows,
      invalidEvidenceRows: 0,
      unplannedEvidenceRows: 0,
    },
    source: {
      ...summary,
      baselineV1Rows: controls.plan.source.v1Rows,
      unmirroredV1Rows,
      missingLegacyRowsForV2: 0,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan: promotion,
    decision: {
      eligibleRows,
      lifecycleRolloutSelectable: eligibleRows > 0,
      finalRecallCutoverBlockedByUnmirroredV1: unmirroredV1Rows > 0,
      automaticPromotionRows: 0,
      requiresSeparateExactApproval: true,
    },
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    liveMutation: {
      evidenceRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}
