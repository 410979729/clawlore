import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { normalizeCandidateContentV1 } =
  jiti("../src/v2/application/candidate-content-quality-review.ts");
const { planCandidateCompanionDispositionV1 } =
  jiti("../src/v2/application/candidate-companion-disposition.ts");
const {
  createLiveCandidateCompanionDispositionPlanV1,
  acceptLiveCandidateCompanionDispositionPlanV1,
} = jiti("../src/v2/operator/live-candidate-companion-disposition.ts");
const { executeLiveCandidateCompanionArchiveV1 } =
  jiti("../src/v2/operator/live-candidate-companion-archive-apply.ts");
const { inspectLiveCandidateCompanionArchiveV1 } =
  jiti("../src/v2/operator/live-candidate-companion-archive-apply.ts");
const { createLivePostCompanionArchiveCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-companion-archive-candidate-plan.ts");
const { inspectLegacySqliteSnapshotV2 } =
  jiti("../src/v2/operator/legacy-v1-snapshot.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = "2026-07-13T10:00:00.000Z";
const facts = [
  {
    key: "local_collaboration_control_plane",
    category: "decision",
    coverage: "materially_new_bounded_truth",
    pattern: "tool-fields-block",
    lane: "tool_payload_rejection_review",
    original: "Files:\n/tmp/local-control\nResult: local collaboration control plane",
    rewritten: "Local multi-agent collaboration uses one authoritative control plane for identity, authorization, routing, acknowledgements, and result acceptance.",
  },
  {
    key: "memory_capability_boundary",
    category: "fact",
    coverage: "covered_by_existing_truth",
    pattern: "command-hints-block",
    lane: "command_trace_rejection_review",
    original: "Command hints:\n- inspect memory capability\nResult: storage does not activate capability",
    rewritten: "Durable memory is evidence rather than an agent capability; recall must pass identity, lifecycle, verification, safety, and runtime gates.",
  },
  {
    key: "episode_before_reviewer",
    category: "decision",
    coverage: "covered_by_existing_truth",
    pattern: "command-hints-block",
    lane: "command_trace_rejection_review",
    original: "Command hints:\n- review episode\nResult: record episode before reviewer",
    rewritten: "A completed tool-backed task first remains an auditable candidate episode; reviewer acceptance governs later playbook extraction or promotion.",
  },
];

function lineageReceipt(seed) {
  return {
    schemaVersion: 1,
    evidenceKind: "source-lineage-receipt",
    supportsSourceLineageOnly: true,
    authorizesLifecycleChange: false,
    authorizesVerificationChange: false,
    classification: "reflection_summary",
    sourceEvidenceDigest: sha256(`source:${seed}`),
    eventEvidenceDigest: sha256(`event:${seed}`),
    rolloutId: "lineage-rollout-r1",
    planDigest: sha256("lineage-plan"),
    proposedReceiptPayloadDigest: sha256("lineage-payload"),
    recordedAt: now,
    preservesLifecycle: true,
    preservesVerification: true,
  };
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function sourceState() {
  return {
    v1Rows: 6,
    v2Rows: 6,
    candidateRows: 6,
    activeRows: 0,
    archivedRows: 0,
    compatibilityRows: 6,
    currentFtsRows: 6,
    vectorRows: 6,
    relationRows: 6,
    pendingOutboxRows: 0,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-companion-disposition-"));
  const source = join(root, "live.sqlite3");
  const rewritePlanPath = join(root, "rewrite-plan.json");
  const rewriteApplyPath = join(root, "rewrite-apply.json");
  const rewritePostcheckPath = join(root, "rewrite-postcheck.json");
  const qualityPath = join(root, "quality.json");
  const safetyPath = join(root, "safety.json");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,
      scope TEXT NOT NULL,timestamp INTEGER NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL,content TEXT NOT NULL,category TEXT NOT NULL,address_json TEXT NOT NULL,
      tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,visibility TEXT NOT NULL,
      retention TEXT NOT NULL,workspace_id TEXT,project_id TEXT,conversation_id TEXT,thread_id TEXT,
      customer_id TEXT,task_id TEXT,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE memory_revisions(revision_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
      content TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,created_at TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
      external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE memory_relations(relation_id TEXT PRIMARY KEY,from_revision_id TEXT NOT NULL,to_revision_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_acl(acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
      visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_events(event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,event_type TEXT NOT NULL,
      actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY,content TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY,content TEXT NOT NULL,category TEXT NOT NULL);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT,verified_at TEXT);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY,state TEXT,verified_at TEXT);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,item_id TEXT,revision_id TEXT,operation TEXT,projection TEXT,
      attempts INTEGER,available_at TEXT,created_at TEXT,processed_at TEXT,last_error TEXT);
    CREATE TABLE clawlore_rollouts_v2(rollout_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,control_sha256 TEXT NOT NULL,
      readiness_sha256 TEXT NOT NULL,legacy_logical_digest TEXT NOT NULL,rows_applied INTEGER NOT NULL,
      applied_at TEXT NOT NULL,v1_fallback_reads INTEGER NOT NULL,context_engine_enabled INTEGER NOT NULL,
      final_recall_cutover_enabled INTEGER NOT NULL);`);
  const groups = [];
  const rewriteRows = [];
  const qualityRows = [];
  const safetyRows = [];
  for (const [index, fact] of facts.entries()) {
    const repId = `${fact.key}:representative`;
    const companionId = `${fact.key}:companion`;
    const repItem = `legacy:${repId}`;
    const companionItem = `legacy:${companionId}`;
    const repOldRevision = `revision:${repId}:1`;
    const repCurrentRevision = `revision:${repId}:2`;
    const companionRevision = `revision:${companionId}:1`;
    const repLineage = lineageReceipt(repId);
    const companionLineage = lineageReceipt(companionId);
    const repHash = sha256(repItem);
    const companionHash = sha256(companionItem);
    const originalNormalized = sha256(normalizeCandidateContentV1(fact.original));
    const rewrittenNormalized = sha256(normalizeCandidateContentV1(fact.rewritten));
    const rewriteReceipt = {
      schemaVersion: 1,
      rolloutId: "clawlore-v2-durable-rewrite-apply-r1",
      planDigest: "pending",
      factKey: fact.key,
      previousContentDigest: sha256(fact.original),
      rewrittenContentDigest: sha256(fact.rewritten),
      sourceLineageReceiptDigest: sha256(JSON.stringify(repLineage)),
      appliedAt: now,
      preservesCurrentLifecycle: true,
      preservesVerification: true,
      preservesAddress: true,
    };
    groups.push({
      normalizedContentDigest: originalNormalized,
      expectedGroupSize: 2,
      representativeItemIdSha256: repHash,
      companionItemIdSha256: companionHash,
      factKey: fact.key,
      category: fact.category,
      knowledgeCoverage: fact.coverage,
      knowledgeEvidenceDigest: sha256(`knowledge:${fact.key}`),
      proposedContentDigest: sha256(fact.rewritten),
      proposedNormalizedContentDigest: rewrittenNormalized,
      proposedContentLength: fact.rewritten.length,
      captureSafetyAllowed: true,
      corpusCollisionRows: 0,
      proposedRepresentativeAction: "rewrite_candidate_under_separate_exact_apply",
      proposedCompanionAction: "hold_candidate_until_post_rewrite_dedupe",
    });
    rewriteRows.push({
      itemIdSha256: repHash,
      currentRevisionIdSha256: sha256(repOldRevision),
      contentDigest: sha256(fact.original),
      normalizedContentDigest: originalNormalized,
      sourceLineageReceiptDigest: sha256(JSON.stringify(repLineage)),
      category: fact.category,
      factKey: fact.key,
      role: "rewrite_representative",
      proposedContentDigest: sha256(fact.rewritten),
      proposedNormalizedContentDigest: rewrittenNormalized,
      proposedAction: "rewrite_candidate_under_separate_exact_apply",
      mutationReady: false,
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    }, {
      itemIdSha256: companionHash,
      currentRevisionIdSha256: sha256(companionRevision),
      contentDigest: sha256(fact.original),
      normalizedContentDigest: originalNormalized,
      sourceLineageReceiptDigest: sha256(JSON.stringify(companionLineage)),
      category: fact.category,
      factKey: fact.key,
      role: "post_rewrite_dedupe_hold",
      proposedContentDigest: sha256(fact.rewritten),
      proposedNormalizedContentDigest: rewrittenNormalized,
      proposedAction: "hold_candidate_until_post_rewrite_dedupe",
      mutationReady: false,
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    });
    const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main",
      visibility: "private", retention: "durable", workspaceId: "test" });
    for (const [id, itemId, currentRevision, content, lineage, revisionNo] of [
      [repId, repItem, repCurrentRevision, fact.rewritten, repLineage, 2],
      [companionId, companionItem, companionRevision, fact.original, companionLineage, 1],
    ]) {
      db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
        .run(id, fact.original, fact.category, "private", index + 1, JSON.stringify({ source: "reflection-summary" }));
      db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(itemId, currentRevision, revisionNo, content, fact.category, address, "local", "joy", "main",
          "private", "durable", "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
      if (itemId === repItem) {
        db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
          .run(repOldRevision, itemId, 1, fact.original, "superseded", "unverified", null, now);
      }
      db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
        .run(currentRevision, itemId, revisionNo, content, "candidate", "unverified", null, now);
      const evidence = itemId === repItem
        ? { classification: "reflection_summary", sourceLineageReceiptV1: lineage, durableRewriteReceiptV1: rewriteReceipt }
        : { classification: "reflection_summary", sourceLineageReceiptV1: lineage };
      db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
        .run(`source:${id}:current`, currentRevision, "legacy", id, now, JSON.stringify(evidence));
      db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${id}`, itemId, "joy", "private", "{}", now);
      db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
        .run(`event:${id}`, itemId, currentRevision, "remembered", "fixture", "fixture", now);
      db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, fact.original, "{}");
      db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, content, fact.category);
      db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)").run(itemId, id, "fixture", "verified", now);
      db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
    }
    qualityRows.push({
      itemIdSha256: repHash,
      currentRevisionIdSha256: sha256(repCurrentRevision),
      contentDigest: sha256(fact.rewritten),
      normalizedContentDigest: rewrittenNormalized,
      sourceLineageReceiptDigest: sha256(JSON.stringify(repLineage)),
      category: fact.category,
      contentLengthBand: "le1000",
      captureSafety: { allowed: true },
      targetDuplicateGroupSize: 1,
      corpusDuplicateGroupSize: 1,
      signals: [],
      lane: "manual_semantic_review",
      requiredActions: ["review_factual_accuracy"],
      postLifecycle: "candidate",
      postVerification: "unverified",
    }, {
      itemIdSha256: companionHash,
      currentRevisionIdSha256: sha256(companionRevision),
      contentDigest: sha256(fact.original),
      normalizedContentDigest: originalNormalized,
      sourceLineageReceiptDigest: sha256(JSON.stringify(companionLineage)),
      category: fact.category,
      contentLengthBand: "le4000",
      captureSafety: { allowed: false, reason: "operational-trace", pattern: fact.pattern },
      targetDuplicateGroupSize: 1,
      corpusDuplicateGroupSize: 1,
      signals: ["capture_safety:operational-trace"],
      lane: "capture_safety_reject_review",
      requiredActions: ["keep_candidate"],
      postLifecycle: "candidate",
      postVerification: "unverified",
    });
    safetyRows.push({
      itemIdSha256: companionHash,
      currentRevisionIdSha256: sha256(companionRevision),
      contentDigest: sha256(fact.original),
      normalizedContentDigest: originalNormalized,
      sourceLineageReceiptDigest: sha256(JSON.stringify(companionLineage)),
      category: fact.category,
      captureSafetyReason: "operational-trace",
      captureSafetyPattern: fact.pattern,
      exactDuplicate: false,
      oversized: false,
      lane: fact.lane,
      requiredActions: ["operator_decision_required"],
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    });
  }
  const rewriteSummary = {
    targetGroups: 3, targetRows: 6, rewriteRepresentativeRows: 3, postRewriteDedupeHoldRows: 3,
    coveredByExistingTruthGroups: 2, materiallyNewTruthGroups: 1, captureSafeProposals: 3,
    corpusCollisionRows: 0, mutationReadyRows: 0,
  };
  const rewriteCore = {
    proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
    adjudicationPlanDigest: sha256("adjudication-plan"),
    adjudicationPreviewSha256: sha256("adjudication-preview"),
    rewritePayloadDigest: sha256("rewrite-payload"),
    rewritePayloadSha256: sha256("rewrite-payload-file"),
    adjudicationSource: sourceState(),
    appendOnlySourceExtensionRows: 0,
    source: sourceState(),
    summary: rewriteSummary,
    groups: groups.sort((a, b) => a.normalizedContentDigest.localeCompare(b.normalizedContentDigest)),
    rows: rewriteRows.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256)),
  };
  const rewritePlan = {
    schemaVersion: 1,
    phase: "clawlore-candidate-durable-rewrite-proposal-plan",
    createdAt: now,
    ...rewriteCore,
    readOnly: true,
    queryOnly: true,
    containsProposedMemoryContent: false,
    containsOriginalMemoryContent: false,
    containsTranscriptContent: false,
    emitsRawIdentifiers: false,
    rewriteRepresentativeRows: 3,
    postRewriteDedupeHoldRows: 3,
    mutationReadyRows: 0,
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
    planDigest: sha256(JSON.stringify(rewriteCore)),
  };
  for (const fact of facts) {
    const repItem = `legacy:${fact.key}:representative`;
    const rep = db.prepare("SELECT s.evidence_json FROM memory_items i JOIN memory_sources s ON s.revision_id=i.current_revision_id WHERE i.item_id=?")
      .get(repItem);
    const evidence = JSON.parse(rep.evidence_json);
    evidence.durableRewriteReceiptV1.planDigest = rewritePlan.planDigest;
    db.prepare("UPDATE memory_sources SET evidence_json=? WHERE revision_id=(SELECT current_revision_id FROM memory_items WHERE item_id=?)")
      .run(JSON.stringify(evidence), repItem);
  }
  db.close();
  await chmod(source, 0o600);
  await writePrivateJson(rewritePlanPath, rewritePlan);
  const rewritePlanSha = sha256(await readFile(rewritePlanPath));
  const applyReceipt = {
    schemaVersion: 1,
    phase: "clawlore-candidate-durable-rewrite-live-apply",
    rolloutId: "clawlore-v2-durable-rewrite-apply-r1",
    status: "applied",
    appliedAt: now,
    planDigest: rewritePlan.planDigest,
    planSha256: rewritePlanSha,
    source: { ...sourceState(), unchangedDuringApply: true },
    rewrite: {
      representativeRows: 3, companionRowsPreserved: 3, currentLifecycleRowsChanged: 0,
      currentVerificationRowsChanged: 0, companionRowsChanged: 0, nonTargetRowsChanged: 0,
    },
    projections: {
      compatibilityRowsChanged: 0, vectorRowsChanged: 0, relationProjectionRowsChanged: 0,
      pendingOutboxRowsChanged: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
  };
  await writePrivateJson(rewriteApplyPath, applyReceipt);
  const applySha = sha256(await readFile(rewriteApplyPath));
  await writePrivateJson(rewritePostcheckPath, {
    schemaVersion: 1,
    phase: "clawlore-candidate-durable-rewrite-postcheck",
    verifiedAt: now,
    status: "pass",
    rolloutId: applyReceipt.rolloutId,
    planDigest: rewritePlan.planDigest,
    applyReceiptSha256: applySha,
    targetBinding: { representativeRows: 3, companionRows: 3, validRewriteReceiptRows: 3, mismatches: 0 },
    live: { ...sourceState(), relationProjectionRows: 6, relationRows: undefined, integrity: "ok", foreignKeyViolations: 0 },
    preserved: { companionRowsChanged: 0, nonTargetRowsChanged: 0 },
  });
  const qualityCore = {
    proposedReviewId: "post-rewrite-quality-r1",
    remediationPlanDigest: sha256("remediation"),
    remediationPreviewSha256: sha256("remediation-file"),
    source: sourceState(),
    counts: { capture_safety_reject_review: 3, manual_semantic_review: 3 },
    summary: { targetRows: 6, captureSafetyRejectedRows: 3, manualSemanticReviewRows: 3, mutationReadyRows: 0 },
    rows: qualityRows.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256)),
  };
  const quality = {
    schemaVersion: 1,
    phase: "clawlore-candidate-content-quality-review-plan",
    createdAt: now,
    ...qualityCore,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    automaticReviewRows: 0,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresOperatorSemanticReview: true,
    planDigest: sha256(JSON.stringify(qualityCore)),
  };
  await writePrivateJson(qualityPath, quality);
  const qualitySha = sha256(await readFile(qualityPath));
  const safetyCore = {
    proposedReviewId: "post-rewrite-safety-r1",
    contentQualityPlanDigest: quality.planDigest,
    contentQualityPreviewSha256: qualitySha,
    source: sourceState(),
    counts: { command_trace_rejection_review: 2, tool_payload_rejection_review: 1 },
    summary: { targetRows: 3, directTraceReviewRows: 3, automaticArchiveRows: 0, mutationReadyRows: 0 },
    rows: safetyRows.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256)),
  };
  await writePrivateJson(safetyPath, {
    schemaVersion: 1,
    phase: "clawlore-candidate-capture-safety-review-plan",
    createdAt: now,
    ...safetyCore,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    automaticArchiveRows: 0,
    authorizesRejectionMutation: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresOperatorDecision: true,
    planDigest: sha256(JSON.stringify(safetyCore)),
  });
  return { root, source, rewritePlanPath, rewriteApplyPath, rewritePostcheckPath, qualityPath, safetyPath };
}

async function plannedFixture() {
  const paths = await fixture();
  const planPath = join(paths.root, "companion-plan.json");
  const acceptancePath = join(paths.root, "companion-acceptance.json");
  const plan = createLiveCandidateCompanionDispositionPlanV1({
    sourcePath: paths.source,
    rewritePlanPath: paths.rewritePlanPath,
    rewriteApplyReceiptPath: paths.rewriteApplyPath,
    rewritePostcheckPath: paths.rewritePostcheckPath,
    contentQualityPath: paths.qualityPath,
    captureSafetyPath: paths.safetyPath,
    proposedDispositionId: "clawlore-v2-companion-disposition-r1",
    now: () => new Date(now),
  });
  await writePrivateJson(planPath, plan);
  const acceptance = acceptLiveCandidateCompanionDispositionPlanV1({
    sourcePath: paths.source,
    planPath,
    planDigest: plan.planDigest,
    now: () => new Date("2026-07-13T10:01:00.000Z"),
  });
  await writePrivateJson(acceptancePath, acceptance);
  return { ...paths, plan, planPath, acceptancePath };
}

async function applyFixture() {
  const paths = await plannedFixture();
  const archivePath = join(paths.root, "fresh.clawlore2");
  const snapshotReceiptPath = join(paths.root, "fresh.receipt.json");
  const archive = Buffer.from("fixture encrypted snapshot");
  await writeFile(archivePath, archive, { mode: 0o600 });
  await chmod(archivePath, 0o600);
  const legacy = await inspectLegacySqliteSnapshotV2(paths.source);
  await writePrivateJson(snapshotReceiptPath, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-13T10:02:00.000Z",
    status: "pass",
    authorizesV2Writes: false,
    archiveSha256: sha256(archive),
    sourceStableDuringBackup: true,
    restoreVerified: true,
    restoredPlaintextRemoved: true,
    snapshot: {
      schemaDigest: legacy.schemaDigest,
      memoryTruthRows: legacy.memoryTruth.rowCount,
      memoryTruthLogicalDigest: legacy.memoryTruth.logicalDigest,
      integrity: "ok",
      foreignKeyViolations: 0,
    },
  });
  return { ...paths, archivePath, snapshotReceiptPath };
}

test("companion disposition requires the exact three unsafe traces and proposes no automatic mutation", () => {
  const inputs = facts.map((fact, index) => ({
    factKey: fact.key,
    knowledgeCoverage: fact.coverage,
    knowledgeEvidenceDigest: sha256(`knowledge:${index}`),
    representativeItemIdSha256: sha256(`rep:${index}`),
    representativeCurrentRevisionIdSha256: sha256(`rep-rev:${index}`),
    representativeContentDigest: sha256(`rep-content:${index}`),
    representativeNormalizedContentDigest: sha256(`rep-normalized:${index}`),
    representativeSourceLineageReceiptDigest: sha256(`rep-lineage:${index}`),
    representativeRewriteReceiptDigest: sha256(`rep-rewrite:${index}`),
    companionItemIdSha256: sha256(`companion:${index}`),
    companionCurrentRevisionIdSha256: sha256(`companion-rev:${index}`),
    companionContentDigest: sha256(`companion-content:${index}`),
    companionNormalizedContentDigest: sha256(`companion-normalized:${index}`),
    companionSourceLineageReceiptDigest: sha256(`companion-lineage:${index}`),
    category: fact.category,
    captureSafetyReason: "operational-trace",
    captureSafetyPattern: fact.pattern,
    captureSafetyLane: fact.lane,
  }));
  const plan = planCandidateCompanionDispositionV1(inputs);
  assert.equal(plan.summary.softArchiveProposalRows, 3);
  assert.equal(plan.summary.commandTraceRows, 2);
  assert.equal(plan.summary.toolPayloadRows, 1);
  assert.equal(plan.rows.every((row) => row.mutationReady === false && row.proposedLifecycle === "archived"), true);
  assert.throws(() => planCandidateCompanionDispositionV1(inputs.slice(0, 2)), /exactly three/);
});

test("live companion disposition plan and acceptance are exact, redacted, and non-authorizing", async () => {
  const paths = await plannedFixture();
  try {
    assert.equal(paths.plan.summary.targetRows, 3);
    assert.equal(paths.plan.authorizesSoftArchive, false);
    assert.equal(paths.plan.requiresFreshEncryptedSnapshot, true);
    const serialized = JSON.stringify(paths.plan);
    for (const marker of ["/tmp/local-control", "Command hints:", "legacy:memory", "Result:"]) {
      assert.equal(serialized.includes(marker), false);
    }
    const acceptance = JSON.parse(await readFile(paths.acceptancePath, "utf8"));
    assert.equal(acceptance.status, "pass");
    assert.equal(acceptance.liveBindingMismatches, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live companion disposition fails closed on control tamper or target drift", async () => {
  const tampered = await fixture();
  try {
    const rewrite = JSON.parse(await readFile(tampered.rewritePlanPath, "utf8"));
    rewrite.groups[0].knowledgeEvidenceDigest = sha256("tampered");
    await writePrivateJson(tampered.rewritePlanPath, rewrite);
    assert.throws(() => createLiveCandidateCompanionDispositionPlanV1({
      sourcePath: tampered.source,
      rewritePlanPath: tampered.rewritePlanPath,
      rewriteApplyReceiptPath: tampered.rewriteApplyPath,
      rewritePostcheckPath: tampered.rewritePostcheckPath,
      contentQualityPath: tampered.qualityPath,
      captureSafetyPath: tampered.safetyPath,
      proposedDispositionId: "clawlore-v2-companion-disposition-r1",
    }), /rewrite plan digest is invalid/);
  } finally {
    await rm(tampered.root, { recursive: true, force: true });
  }
  const drifted = await fixture();
  try {
    const db = new DatabaseSync(drifted.source);
    db.prepare(`UPDATE memory_items SET content=content || ' drift'
      WHERE item_id=(SELECT item_id FROM memory_items WHERE item_id LIKE '%:companion' ORDER BY item_id LIMIT 1)`).run();
    db.close();
    assert.throws(() => createLiveCandidateCompanionDispositionPlanV1({
      sourcePath: drifted.source,
      rewritePlanPath: drifted.rewritePlanPath,
      rewriteApplyReceiptPath: drifted.rewriteApplyPath,
      rewritePostcheckPath: drifted.rewritePostcheckPath,
      contentQualityPath: drifted.qualityPath,
      captureSafetyPath: drifted.safetyPath,
      proposedDispositionId: "clawlore-v2-companion-disposition-r1",
    }), /live candidate no longer matches/);
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }
});

test("exact companion archive creates three archived revisions and preserves truth projections", async () => {
  const paths = await applyFixture();
  try {
    const priorBaselinePath = join(paths.root, "prior-baseline.json");
    const priorRows = facts.flatMap((fact) => [
      sha256(`legacy:${fact.key}:representative`),
      sha256(`legacy:${fact.key}:companion`),
    ]).sort().map((itemIdSha256) => ({
      itemIdSha256,
      disposition: "hold_candidate",
      reasonCodes: ["operator_review_required"],
    }));
    await writePrivateJson(priorBaselinePath, {
      schemaVersion: 1,
      phase: "clawlore-post-assignment-candidate-plan",
      createdAt: now,
      proposedRolloutId: "candidate-baseline-before-archive-r1",
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      assignment: {},
      source: {
        ...sourceState(),
        baselineV1Rows: 6,
        unmirroredV1Rows: 0,
        missingLegacyRowsForV2: 0,
        candidateBaselineUnchanged: true,
        sourceUnchangedDuringPlan: true,
      },
      candidatePromotionPlan: {
        schemaVersion: 1,
        phase: "clawlore-candidate-promotion-review-plan",
        readOnly: true,
        emitsItemIds: false,
        authorizesLiveMutation: false,
        automaticPromotionRows: 0,
        counts: {
          eligible_for_promotion: 0,
          hold_candidate: 6,
          quarantine: 0,
          preserve_archived: 0,
        },
        rows: priorRows,
        planDigest: sha256(JSON.stringify(priorRows)),
      },
      decision: {
        eligibleRows: 0,
        lifecycleRolloutSelectable: false,
        finalRecallCutoverBlockedByUnmirroredV1: false,
        automaticPromotionRows: 0,
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
    });
    const receipt = await executeLiveCandidateCompanionArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      dispositionAcceptancePath: paths.acceptancePath,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "clawlore-v2-companion-archive-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-13T10:03:00.000Z"),
    });
    assert.equal(receipt.archive.candidateRowsArchived, 3);
    assert.equal(receipt.sourceAfter.candidateRows, 3);
    assert.equal(receipt.sourceAfter.archivedRows, 3);
    assert.equal(receipt.projections.currentFtsRowsChanged, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='superseded'").get().rows, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='archived'").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_sources").get().rows, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_relations").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_events WHERE event_type='archived'").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_fts_v2").get().rows, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_vector_projection_v2").get().rows, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM projection_outbox").get().rows, 0);
    db.close();
    const applyReceiptPath = join(paths.root, "apply-receipt.json");
    await writePrivateJson(applyReceiptPath, receipt);
    const postcheck = inspectLiveCandidateCompanionArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      applyReceiptPath,
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-13T10:04:00.000Z"),
    });
    assert.equal(postcheck.targetBinding.archivedCompanionRows, 3);
    assert.equal(postcheck.targetBinding.preservedRepresentativeRows, 3);
    assert.equal(postcheck.targetBinding.validDispositionReceiptRows, 3);
    assert.equal(postcheck.targetBinding.mismatches, 0);
    const postcheckPath = join(paths.root, "postcheck.json");
    await writePrivateJson(postcheckPath, postcheck);
    const rebased = createLivePostCompanionArchiveCandidatePlanV1({
      sourcePath: paths.source,
      priorBaselinePath,
      companionPlanPath: paths.planPath,
      applyReceiptPath,
      postcheckPath,
      planDigest: paths.plan.planDigest,
      proposedRolloutId: "candidate-baseline-after-archive-r1",
      now: () => new Date("2026-07-13T10:05:00.000Z"),
    });
    assert.equal(rebased.source.candidateRows, 3);
    assert.equal(rebased.source.archivedRows, 3);
    assert.equal(rebased.candidatePromotionPlan.counts.hold_candidate, 3);
    assert.equal(rebased.archiveRebase.archivedCandidateRows, 3);
    assert.equal(rebased.archiveRebase.removedItemIdSha256.length, 3);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("exact companion archive rejects stale snapshots and plan drift before writes", async () => {
  const stale = await applyFixture();
  try {
    await assert.rejects(executeLiveCandidateCompanionArchiveV1({
      sourcePath: stale.source,
      planPath: stale.planPath,
      dispositionAcceptancePath: stale.acceptancePath,
      snapshotArchivePath: stale.archivePath,
      snapshotReceiptPath: stale.snapshotReceiptPath,
      rolloutId: "clawlore-v2-companion-archive-r1",
      planDigest: stale.plan.planDigest,
      now: () => new Date("2026-07-13T12:03:00.000Z"),
    }), /snapshot is invalid, stale/);
    const db = new DatabaseSync(stale.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 0);
    db.close();
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});
