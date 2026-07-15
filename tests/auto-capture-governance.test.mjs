import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  autoRecallGovernanceEligibility,
  regexFallbackGovernance,
} = jiti("../src/auto-capture-governance.ts");

test("extractor failure leaves regex fallback auditable but not auto-injectable", () => {
  const metadata = regexFallbackGovernance("smart_extraction_error:injected failure");
  assert.equal(metadata.state, "pending");
  assert.equal(metadata.trust, "degraded");
  assert.equal(metadata.extraction_degraded, true);
  assert.deepEqual(autoRecallGovernanceEligibility(metadata), {
    eligible: false,
    reason: "state_not_confirmed",
  });
});

test("manual lifecycle promotion alone cannot bypass degraded trust", () => {
  const degraded = { ...regexFallbackGovernance("smart_extraction_error:timeout"), state: "confirmed" };
  assert.deepEqual(autoRecallGovernanceEligibility(degraded), {
    eligible: false,
    reason: "degraded_extraction",
  });

  const reviewed = {
    ...degraded,
    trust: "normal",
    extraction_degraded: false,
    confidence: 0.8,
    degraded_reason: "",
  };
  assert.deepEqual(autoRecallGovernanceEligibility(reviewed), { eligible: true });
});

test("healthy regex capture remains confirmed and recall-eligible", () => {
  const metadata = regexFallbackGovernance();
  assert.equal(metadata.state, "confirmed");
  assert.deepEqual(autoRecallGovernanceEligibility(metadata), { eligible: true });
});
