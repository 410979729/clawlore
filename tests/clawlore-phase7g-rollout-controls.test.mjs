import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { planCandidatePromotionsV1 } = jiti("../src/v2/application/candidate-promotion-policy.ts");
const { buildPhase7GControlBundleV1, validatePhase7GApprovalV1 } =
  jiti("../src/v2/application/phase7g-rollout-controls.ts");
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/clawlore-phase7f-ranking-promotion-v1.json", import.meta.url),
));

const digest = (character) => character.repeat(64);

function promotionPlan() {
  return planCandidatePromotionsV1(fixture.promotion.rows.filter((row) => row.lifecycle === "candidate"));
}

function compatibilityPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: "clawlore-compatibility-backfill-plan",
    readOnly: true,
    emitsMemoryContent: false,
    sourceUnchanged: true,
    sourceRows: 8,
    v2Rows: 8,
    existingProjectionRows: 0,
    expectedProjectionRows: 8,
    mappingMismatchRows: 0,
    rawLegacyMetadataCopied: false,
    bootstrapSource: "memory_truth.metadata_text",
    indexedLegacyMetadataFields: [
      "l0_abstract", "l1_overview", "l2_content", "keywords",
      "entities", "tags", "category", "tier",
    ],
    planDigest: digest("b"),
    authorizesLiveMutation: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    receiptSha256: digest("a"),
    createdAt: "2026-07-12T11:00:00.000Z",
    sourceLogicalDigest: digest("c"),
    sourceRows: 8,
    candidateRows: 7,
    restoreVerified: true,
    sourceUnchanged: true,
    plaintextResidueFiles: 0,
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return buildPhase7GControlBundleV1({
    compatibilityRolloutId: "clawlore-v2-compat-fixture-r1",
    promotionRolloutId: "clawlore-v2-promotion-fixture-r1",
    snapshot: snapshot(),
    compatibilityPlan: compatibilityPlan(),
    promotionPlan: promotionPlan(),
    now: () => new Date("2026-07-12T11:30:00.000Z"),
    ...overrides,
  });
}

test("phase 7G controls bind fresh snapshot and keep two rollout approvals isolated", () => {
  const result = bundle();
  assert.equal(result.status, "ready_for_separate_approvals");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.snapshot.ageSeconds, 1800);
  assert.equal(result.approvals.compatibilityBackfill.mode, "compatibility-backfill");
  assert.equal(result.approvals.candidatePromotion.mode, "candidate-promotion");
  assert.equal(result.approvals.candidatePromotion.eligibleRows, 3);
  assert.equal(result.isolation.oneApprovalCannotAuthorizeBothActions, true);
  assert.equal(result.authorizesCompatibilityBackfill, false);
  assert.equal(result.authorizesCandidatePromotion, false);
  assert.equal(result.authorizesContextEngine, false);
  assert.equal(result.authorizesPromptMutation, false);
  assert.equal(result.authorizesFinalRecallCutover, false);
  assert.equal(JSON.stringify(result).includes("manual-direct"), false);
  assert.equal(JSON.stringify(result).includes("telegram:default:joy"), false);
});

test("phase 7G controls fail closed on stale snapshot or incomplete projection mapping", () => {
  const stale = bundle({ snapshot: snapshot({ createdAt: "2026-07-12T09:00:00.000Z" }) });
  assert.equal(stale.status, "blocked");
  assert.ok(stale.blockers.includes("fresh_encrypted_snapshot_required"));

  const incomplete = bundle({ compatibilityPlan: compatibilityPlan({ v2Rows: 7, mappingMismatchRows: 1 }) });
  assert.equal(incomplete.status, "blocked");
  assert.ok(incomplete.blockers.includes("compatibility_projection_mapping_incomplete"));
  const unsafeAllowlist = bundle({
    compatibilityPlan: compatibilityPlan({
      indexedLegacyMetadataFields: [
        "l0_abstract", "l1_overview", "l2_content", "keywords",
        "entities", "tags", "category", "sender_id",
      ],
    }),
  });
  assert.equal(unsafeAllowlist.status, "blocked");
  assert.ok(unsafeAllowlist.blockers.includes("compatibility_index_allowlist_invalid"));
  const partialPromotion = bundle({ snapshot: snapshot({ candidateRows: 8 }) });
  assert.equal(partialPromotion.status, "blocked");
  assert.ok(partialPromotion.blockers.includes("promotion_plan_candidate_coverage_incomplete"));
  assert.throws(() => buildPhase7GControlBundleV1({
    compatibilityRolloutId: "clawlore-v2-shared-fixture-r1",
    promotionRolloutId: "clawlore-v2-shared-fixture-r1",
    snapshot: snapshot(),
    compatibilityPlan: compatibilityPlan(),
    promotionPlan: promotionPlan(),
  }), /must be distinct/);
});

test("a projection approval cannot authorize promotion or broader runtime changes", () => {
  const controls = bundle();
  const approval = {
    schemaVersion: 1,
    rolloutId: controls.approvals.compatibilityBackfill.rolloutId,
    mode: "compatibility-backfill",
    decision: "approved",
    actor: "operator:fixture",
    approvedAt: "2026-07-12T11:31:00.000Z",
    planDigest: controls.approvals.compatibilityBackfill.planDigest,
    preserveV1Fallback: true,
    allowContextEngine: false,
    allowPromptMutation: false,
    allowFinalRecallCutover: false,
  };
  assert.deepEqual(validatePhase7GApprovalV1({
    approval,
    expected: controls.approvals.compatibilityBackfill,
  }), { valid: true, reasonCodes: [] });
  const promotionAttempt = validatePhase7GApprovalV1({
    approval,
    expected: controls.approvals.candidatePromotion,
  });
  assert.equal(promotionAttempt.valid, false);
  assert.ok(promotionAttempt.reasonCodes.includes("approval_rollout_mismatch"));
  assert.ok(promotionAttempt.reasonCodes.includes("approval_mode_mismatch"));
  assert.ok(promotionAttempt.reasonCodes.includes("approval_plan_digest_mismatch"));

  const overbroad = validatePhase7GApprovalV1({
    approval: { ...approval, allowPromptMutation: true },
    expected: controls.approvals.compatibilityBackfill,
  });
  assert.equal(overbroad.valid, false);
  assert.ok(overbroad.reasonCodes.includes("approval_exceeds_authorized_boundary"));
});
