import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { evaluateFixtureRankingCompatibilityV1, projectLegacySearchMetadataV1 } =
  jiti("../src/v2/eval/fixture-ranking-compatibility.ts");
const { planCandidatePromotionsV1 } = jiti("../src/v2/application/candidate-promotion-policy.ts");
const fixture = JSON.parse(await readFile(new URL("./fixtures/clawlore-phase7f-ranking-promotion-v1.json", import.meta.url)));

test("fixture compatibility projection restores V1 ranking without indexing raw metadata", () => {
  const report = evaluateFixtureRankingCompatibilityV1(fixture.ranking);
  assert.equal(report.fixtureOnly, true);
  assert.equal(report.emitsFixtureContent, false);
  assert.ok(report.aggregate.minimumCurrentV2TopKOverlap < 0.8);
  assert.equal(report.aggregate.minimumCompatibilityV2TopKOverlap, 1);
  assert.equal(report.aggregate.minimumCompatibilityV2RankAgreement, 1);
  assert.equal(report.compatibilityProjection.rawLegacyMetadataCopied, false);
  assert.equal(report.compatibilityProjection.bootstrapSource, "memory_truth.metadata_text");
  assert.equal(report.compatibilityProjection.requiresOneTimeBackfill, true);
  assert.equal(report.compatibilityProjection.ignoredMetadataFieldCount, 3);
  assert.equal(report.decision.compatibilityDesignReady, true);
  assert.equal(report.decision.authorizesLiveSchemaChange, false);
  assert.equal(report.decision.authorizesLiveReindex, false);
  assert.equal(report.decision.authorizesFinalRecallCutover, false);
  const projected = projectLegacySearchMetadataV1(fixture.ranking.rows[0].legacyMetadata);
  assert.match(projected, /OpenClaw recovery healthz/);
  assert.doesNotMatch(projected, /must-not-be-indexed/);
  assert.equal(JSON.stringify(report).includes("Gateway restart workflow"), false);
});

test("candidate promotion policy separates eligible review from hold, quarantine, and archive", () => {
  const plan = planCandidatePromotionsV1(fixture.promotion.rows);
  assert.deepEqual(plan.counts, {
    eligible_for_promotion: 3,
    hold_candidate: 2,
    quarantine: 2,
    preserve_archived: 1,
  });
  assert.equal(plan.automaticPromotionRows, 0);
  assert.equal(plan.authorizesLiveMutation, false);
  assert.equal("requiresSeparateOperatorApproval" in plan, false);
  assert.equal(plan.rows.some((row) => "itemId" in row), false);
  assert.equal(JSON.stringify(plan).includes("telegram:default:joy"), false);
  assert.equal(plan.rows.find((row) => row.disposition === "eligible_for_promotion")
    .reasonCodes.includes("evidence_complete"), true);
});

test("candidate promotion policy fails closed on duplicate ids and spoofed private attribution", () => {
  assert.throws(() => planCandidatePromotionsV1([
    fixture.promotion.rows[0],
    fixture.promotion.rows[0],
  ]), /unique and non-empty/);
  const spoofed = structuredClone(fixture.promotion.rows[0]);
  spoofed.itemId = "spoofed";
  spoofed.evidence.resolvedPrincipalId = "telegram:default:someone-else";
  const plan = planCandidatePromotionsV1([spoofed]);
  assert.equal(plan.counts.hold_candidate, 1);
  assert.ok(plan.rows[0].reasonCodes.includes("principal_evidence_address_mismatch"));
});
