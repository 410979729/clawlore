#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { planCandidatePromotionsV1 } = jiti("../src/v2/application/candidate-promotion-policy.ts");
const { buildPhase7GControlBundleV1 } = jiti("../src/v2/application/phase7g-rollout-controls.ts");
const fixture = JSON.parse(await readFile(
  new URL("../tests/fixtures/clawlore-phase7f-ranking-promotion-v1.json", import.meta.url),
));
const promotionPlan = planCandidatePromotionsV1(
  fixture.promotion.rows.filter((row) => row.lifecycle === "candidate"),
);
const report = buildPhase7GControlBundleV1({
  compatibilityRolloutId: "clawlore-v2-compat-fixture-r1",
  promotionRolloutId: "clawlore-v2-promotion-fixture-r1",
  snapshot: {
    receiptSha256: "a".repeat(64),
    createdAt: "2026-07-12T11:00:00.000Z",
    sourceLogicalDigest: "b".repeat(64),
    sourceRows: fixture.promotion.rows.length,
    candidateRows: fixture.promotion.rows.filter((row) => row.lifecycle === "candidate").length,
    restoreVerified: true,
    sourceUnchanged: true,
    plaintextResidueFiles: 0,
  },
  compatibilityPlan: {
    schemaVersion: 1,
    phase: "clawlore-compatibility-backfill-plan",
    readOnly: true,
    emitsMemoryContent: false,
    sourceUnchanged: true,
    sourceRows: fixture.promotion.rows.length,
    v2Rows: fixture.promotion.rows.length,
    existingProjectionRows: 0,
    expectedProjectionRows: fixture.promotion.rows.length,
    mappingMismatchRows: 0,
    rawLegacyMetadataCopied: false,
    indexedLegacyMetadataFields: [
      "l0_abstract", "l1_overview", "l2_content", "keywords",
      "entities", "tags", "category", "tier",
    ],
    planDigest: "c".repeat(64),
    authorizesLiveMutation: false,
  },
  promotionPlan,
  now: () => new Date("2026-07-12T11:30:00.000Z"),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
