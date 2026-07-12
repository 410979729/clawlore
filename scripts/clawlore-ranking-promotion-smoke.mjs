#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { evaluateFixtureRankingCompatibilityV1 } = jiti("../src/v2/eval/fixture-ranking-compatibility.ts");
const { planCandidatePromotionsV1 } = jiti("../src/v2/application/candidate-promotion-policy.ts");
const fixturePath = new URL("../tests/fixtures/clawlore-phase7f-ranking-promotion-v1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const report = {
  schemaVersion: 1,
  phase: "clawlore-phase7f-ranking-promotion-smoke",
  ranking: evaluateFixtureRankingCompatibilityV1(fixture.ranking),
  promotion: planCandidatePromotionsV1(fixture.promotion.rows),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
