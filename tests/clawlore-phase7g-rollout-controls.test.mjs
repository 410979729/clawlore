import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { planCandidatePromotionsV1 } = jiti("../src/v2/application/candidate-promotion-policy.ts");
const { buildPhase7GControlBundleV1 } =
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

test("phase 7G controls bind fresh snapshot and keep two bounded plans isolated", () => {
  const result = bundle();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.snapshot.ageSeconds, 1800);
  assert.equal(result.plans.compatibilityBackfill.mode, "compatibility-backfill");
  assert.equal(result.plans.candidatePromotion.mode, "candidate-promotion");
  assert.equal(result.plans.candidatePromotion.eligibleRows, 3);
  assert.equal(result.isolation.compatibilityPlanCannotPromoteCandidates, true);
  assert.equal(result.isolation.promotionPlanCannotCreateProjection, true);
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

test("projection and promotion remain isolated without an approval control", () => {
  const controls = bundle();
  assert.notEqual(controls.plans.compatibilityBackfill.rolloutId, controls.plans.candidatePromotion.rolloutId);
  assert.notEqual(controls.plans.compatibilityBackfill.planDigest, controls.plans.candidatePromotion.planDigest);
  assert.equal("approvals" in controls, false);
  assert.equal(JSON.stringify(controls).includes("OperatorApproval"), false);
});
