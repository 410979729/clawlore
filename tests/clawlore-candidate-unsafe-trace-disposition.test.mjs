import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { planCandidateUnsafeTraceDispositionV1 } =
  jiti("../src/v2/application/candidate-unsafe-trace-disposition.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function row(seed, disposition, reason, oversized = false) {
  return {
    itemIdSha256: sha256(`item:${seed}`),
    currentRevisionIdSha256: sha256(`revision:${seed}`),
    contentDigest: sha256(`content:${seed}`),
    normalizedContentDigest: sha256(`normalized:${seed}`),
    sourceLineageReceiptDigest: sha256(`receipt:${seed}`),
    category: "fact",
    captureSafetyPattern: "command-hints-block",
    captureSafetyLane: oversized ? "oversized_operational_trace_rewrite_review" : "command_trace_rejection_review",
    oversized,
    resultDigest: sha256(`result:${seed}`),
    resultLengthBand: oversized ? "gt4000" : "le1000",
    disposition,
    reason,
    proposedLifecycle: "candidate",
    proposedVerification: "unverified",
    mutationReady: false,
  };
}

test("unsafe trace disposition separates reversible archive from bounded rewrite design", () => {
  const plan = planCandidateUnsafeTraceDispositionV1([
    row("archive", "soft_archive_proposal", "transient_runtime_state"),
    row("semantic", "bounded_rewrite_hold", "semantic_result_requires_rewrite_review"),
    row("oversized", "bounded_rewrite_hold", "oversized_trace_requires_segmentation", true),
  ]);
  assert.deepEqual(plan.summary, {
    targetRows: 3,
    softArchiveRows: 1,
    boundedRewriteRows: 2,
    oversizedSegmentationRows: 1,
    semanticExtractionRows: 1,
    mutationReadyRows: 0,
  });
  assert.equal(plan.archiveRows[0].proposedLifecycle, "archived");
  assert.equal(plan.archiveRows[0].proposedVerification, "unverified");
  assert.equal(plan.rewriteDesigns.find((entry) => entry.rewriteDesign === "segment_oversized_result")?.maximumProposedRows, 4);
  assert.equal(plan.rewriteDesigns.every((entry) => entry.removeCommandAndToolEnvelope
    && entry.requireCaptureSafetyPass && entry.requireCorpusDeduplication
    && entry.proposedLifecycle === "candidate" && entry.mutationReady === false), true);
  assert.equal(JSON.stringify(plan).includes("content:"), false);
});

test("unsafe trace disposition fails closed on duplicates and inconsistent oversized rows", () => {
  const duplicate = row("same", "soft_archive_proposal", "transient_runtime_state");
  assert.throws(() => planCandidateUnsafeTraceDispositionV1([duplicate, duplicate]), /must be unique/);
  assert.throws(() => planCandidateUnsafeTraceDispositionV1([
    row("bad", "bounded_rewrite_hold", "semantic_result_requires_rewrite_review", true),
  ]), /segmentation design does not match/);
});
