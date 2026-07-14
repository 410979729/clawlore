import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { adjudicateCandidatePostRewriteReviewV1 } =
  jiti("../src/v2/application/candidate-post-rewrite-adjudication.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function reviewRows() {
  return Array.from({ length: 58 }, (_, index) => ({
    itemIdSha256: sha256(`item:${index}`),
    currentRevisionIdSha256: sha256(`revision:${index}`),
    contentDigest: sha256(`content:${index}`),
    normalizedContentDigest: sha256(`normalized:${index}`),
    sourceLineageReceiptDigest: sha256(`lineage:${index}`),
    category: index % 3 === 0 ? "decision" : "fact",
    contentLengthBand: "le1000",
    captureSafety: { allowed: true },
    targetDuplicateGroupSize: index < 2 ? 2 : 1,
    corpusDuplicateGroupSize: index < 2 ? 2 : 1,
    signals: index < 2 ? ["exact_normalized_duplicate"] : [],
    lane: index < 2 ? "exact_duplicate_review" : "manual_semantic_review",
    requiredActions: ["operator_review"],
    postLifecycle: "candidate",
    postVerification: "unverified",
  }));
}

function decisions(rows) {
  return rows.map((row, index) => ({
    itemIdSha256: row.itemIdSha256,
    disposition: index < 24 ? "propose_soft_archive" : "retain_candidate_for_verification",
    basis: index < 24 ? "transient_conversation" : "durable_content_requires_verification",
    evidenceDigest: sha256(`evidence:${index}`),
  }));
}

test("post-rewrite adjudication closes the exact 2 duplicate / 56 semantic review set", () => {
  const rows = reviewRows();
  const result = adjudicateCandidatePostRewriteReviewV1(rows, decisions(rows));
  assert.deepEqual(result.summary, {
    targetRows: 58,
    exactDuplicateRows: 2,
    manualSemanticRows: 56,
    proposedSoftArchiveRows: 24,
    retainedForVerificationRows: 34,
    boundedRewriteHoldRows: 0,
    mutationReadyRows: 0,
  });
  assert.equal(result.rows.every((row) => row.mutationReady === false), true);
  assert.equal(result.rows.every((row) => row.proposedLifecycle === "candidate"), true);
  assert.equal(result.rows.every((row) => row.proposedVerification === "unverified"), true);
});

test("post-rewrite adjudication requires exact decision coverage and safe disposition bases", () => {
  const rows = reviewRows();
  assert.throws(
    () => adjudicateCandidatePostRewriteReviewV1(rows, decisions(rows).slice(0, -1)),
    /cover the exact review set/,
  );
  const invalid = decisions(rows);
  invalid[0] = { ...invalid[0], basis: "durable_content_requires_verification" };
  assert.throws(
    () => adjudicateCandidatePostRewriteReviewV1(rows, invalid),
    /operator decision is invalid/,
  );
});

test("post-rewrite adjudication rejects lane drift and emits no raw source text", () => {
  const rows = reviewRows();
  rows[2] = { ...rows[2], lane: "capture_safety_reject_review", captureSafety: { allowed: false } };
  assert.throws(
    () => adjudicateCandidatePostRewriteReviewV1(rows, decisions(rows)),
    /exact 2 duplicate \/ 56 semantic safe lanes/,
  );
  const clean = reviewRows();
  const serialized = JSON.stringify(adjudicateCandidatePostRewriteReviewV1(clean, decisions(clean)));
  for (const marker of ["legacy:", "Command hints", "Result:", "private memory body"]) {
    assert.equal(serialized.includes(marker), false);
  }
});
