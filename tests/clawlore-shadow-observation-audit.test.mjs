import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditShadowObservation } from "../scripts/clawlore-shadow-observation-audit.mjs";

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    traceId: "clawlore-shadow-0123456789abcdef0123",
    status: "completed",
    principalHash: "0123456789abcdef",
    ingressKind: "direct",
    visibility: "private",
    retrievalInvoked: true,
    candidateCount: 2,
    selectedCount: 1,
    usedTokens: 24,
    stages: [
      { stage: "identity", outcome: "pass", detail: "resolved" },
      { stage: "policy_preflight", outcome: "pass", detail: "same_private_principal" },
      { stage: "candidate_retrieval", outcome: "pass", detail: "2_candidates" },
    ],
    rejectionReasons: [],
    createdAt: "2026-07-12T05:58:08.713Z",
    ...overrides,
  };
}

async function withTrace(lines, mode, callback) {
  const directory = await mkdtemp(join(tmpdir(), "clawlore-shadow-audit-"));
  const traceFile = join(directory, "runtime-shadow.jsonl");
  try {
    await writeFile(traceFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode });
    await chmod(traceFile, mode);
    return await callback(traceFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("shadow observation audit summarizes redacted accepted samples", async () => {
  await withTrace([
    receipt({ status: "skipped", principalHash: undefined, retrievalInvoked: false, candidateCount: 0, selectedCount: 0, usedTokens: 0, stages: [{ stage: "identity", outcome: "skip", detail: "principalId" }] }),
    receipt(),
  ], 0o600, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "pass");
    assert.equal(result.traceMode, "600");
    assert.equal(result.sampleCount, 2);
    assert.deepEqual(result.statuses, { completed: 1, skipped: 1 });
    assert.equal(result.acceptedSampleCount, 1);
    assert.equal(result.acceptedDirectSampleCount, 1);
    assert.equal(result.acceptedGroupSampleCount, 0);
    assert.equal(result.positiveCandidateSampleCount, 1);
    assert.equal(result.maxCandidateCount, 2);
    assert.equal(result.latest.retrievalInvoked, true);
    assert.equal(result.goNoGo.decision, "observe");
    assert.deepEqual(result.goNoGo.blockers, [
      "insufficient_direct_samples",
      "group_boundary_sample_missing",
    ]);
  });
});

test("shadow observation audit rejects unexpected raw-payload fields", async () => {
  await withTrace([receipt({ messageText: "must never enter a redacted trace" })], 0o600, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["line_1:unexpected_receipt_key:messageText"]);
  });
});

test("shadow observation audit rejects group-readable trace files", async () => {
  await withTrace([receipt()], 0o640, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["trace_permissions:640"]);
  });
});

test("shadow observation gate requires direct, group-boundary, and positive samples", async () => {
  await withTrace([
    receipt({ traceId: "clawlore-shadow-direct000000000001" }),
    receipt({ traceId: "clawlore-shadow-direct000000000002", candidateCount: 0, selectedCount: 0, usedTokens: 0 }),
    receipt({ traceId: "clawlore-shadow-direct000000000003", candidateCount: 0, selectedCount: 0, usedTokens: 0 }),
    receipt({
      traceId: "clawlore-shadow-group000000000001",
      ingressKind: "group",
      visibility: "conversation",
      candidateCount: 0,
      selectedCount: 0,
      usedTokens: 0,
      stages: [
        { stage: "identity", outcome: "pass", detail: "resolved" },
        { stage: "policy_preflight", outcome: "pass", detail: "same_conversation" },
        { stage: "candidate_retrieval", outcome: "pass", detail: "0_candidates" },
      ],
    }),
  ], 0o600, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "pass");
    assert.equal(result.acceptedDirectSampleCount, 3);
    assert.equal(result.acceptedGroupSampleCount, 1);
    assert.equal(result.positiveCandidateSampleCount, 1);
    assert.deepEqual(result.goNoGo, {
      decision: "go",
      thresholds: { directSamples: 3, groupSamples: 1, positiveCandidateSamples: 1 },
      blockers: [],
    });
  });
});
