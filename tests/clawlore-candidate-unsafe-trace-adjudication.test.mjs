import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { adjudicateCandidateUnsafeTracesV1 } =
  jiti("../src/v2/application/candidate-unsafe-trace-adjudication.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function input(seed, content, overrides = {}) {
  return {
    content,
    review: {
      itemIdSha256: sha256(`item:${seed}`),
      currentRevisionIdSha256: sha256(`revision:${seed}`),
      contentDigest: sha256(content),
      normalizedContentDigest: sha256(content.toLowerCase()),
      sourceLineageReceiptDigest: sha256(`receipt:${seed}`),
      category: "fact",
      captureSafetyReason: "operational-trace",
      captureSafetyPattern: "command-hints-block",
      exactDuplicate: false,
      oversized: false,
      lane: "command_trace_rejection_review",
      requiredActions: ["operator_decision_required"],
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
      ...overrides,
    },
  };
}

test("unsafe trace adjudication proposes reversible archive only for bounded noise classes", () => {
  const assessment = adjudicateCandidateUnsafeTracesV1([
    input("pure", "request\nCommand hints:\nrg x\nFiles:\na"),
    input("runtime", "request\nCommand hints:\nstatus\nResult:\nGateway active/running, healthz live."),
    input("semantic", "request\nCommand hints:\nread\nResult:\nThe durable design requires a bounded identity resolver."),
    input("oversized", "request\nCommand hints:\nread\nResult:\ncovered report", { oversized: true,
      lane: "oversized_operational_trace_rewrite_review" }),
  ]);
  assert.deepEqual(assessment.counts, { soft_archive_proposal: 2, bounded_rewrite_hold: 2 });
  assert.equal(assessment.reasons.pure_operational_trace, 1);
  assert.equal(assessment.reasons.transient_runtime_state, 1);
  assert.equal(assessment.reasons.semantic_result_requires_rewrite_review, 1);
  assert.equal(assessment.reasons.oversized_trace_requires_segmentation, 1);
  assert.equal(assessment.summary.mutationReadyRows, 0);
  assert.equal(assessment.rows.every((row) => row.proposedLifecycle === "candidate"
    && row.proposedVerification === "unverified" && row.mutationReady === false), true);
});

test("unsafe trace adjudication rejects non-operational and duplicate controls", () => {
  const first = input("same", "request\nCommand hints:\nrg x\nFiles:\na");
  assert.throws(() => adjudicateCandidateUnsafeTracesV1([first, first]), /must be unique/);
  assert.throws(() => adjudicateCandidateUnsafeTracesV1([
    input("bad", "text", { captureSafetyReason: "secret" }),
  ]), /conservative capture-safety rows only/);
});
