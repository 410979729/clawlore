import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditShadowObservation,
  writeShadowObservationReceipt,
} from "../scripts/clawlore-shadow-observation-audit.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { enforcePrivatePath, verifyPrivatePath } = jiti("../src/file-privacy.ts");

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
    comparison: {
      status: "completed",
      primaryCandidateCount: 2,
      comparisonCandidateCount: 2,
      overlapRatio: 1,
      rankAgreement: 1,
      primaryLatencyMs: 12,
      comparisonLatencyMs: 15,
      primaryIdsDigest: "a".repeat(64),
      comparisonIdsDigest: "b".repeat(64),
    },
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
    if (process.platform === "win32") {
      enforcePrivatePath(directory, { kind: "directory" });
      enforcePrivatePath(traceFile, { kind: "file" });
    }
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
    assert.equal(result.traceMode, process.platform === "win32" ? "windows-acl" : "600");
    assert.equal(result.sampleCount, 2);
    assert.deepEqual(result.statuses, { completed: 1, skipped: 1 });
    assert.equal(result.acceptedSampleCount, 1);
    assert.equal(result.acceptedDirectSampleCount, 1);
    assert.equal(result.acceptedGroupSampleCount, 0);
    assert.equal(result.positiveCandidateSampleCount, 1);
    assert.equal(result.maxCandidateCount, 2);
    assert.deepEqual(result.comparison, {
      completedSamples: 1,
      failedSamples: 0,
      minimumOverlapRatio: 1,
      minimumRankAgreement: 1,
      maximumPrimaryLatencyMs: 12,
      maximumComparisonLatencyMs: 15,
    });
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

test("shadow observation audit rejects raw fields inside comparison evidence", async () => {
  await withTrace([receipt({ comparison: { ...receipt().comparison, candidateIds: ["raw-id"] } })], 0o600, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["line_1:unexpected_comparison_key:candidateIds"]);
  });
});

test("shadow observation audit rejects group-readable trace files", {
  skip: process.platform === "win32",
}, async () => {
  await withTrace([receipt()], 0o640, async (traceFile) => {
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["trace_permissions:640"]);
  });
});

test("shadow observation audit rejects a Windows trace without a private DACL", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawlore-shadow-audit-unsafe-windows-"));
  const traceFile = join(directory, "runtime-shadow.jsonl");
  try {
    enforcePrivatePath(directory, { kind: "directory" });
    await writeFile(traceFile, `${JSON.stringify(receipt())}\n`);
    const result = await auditShadowObservation(traceFile);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["trace_permissions:windows_acl"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow observation audit fails closed when the verified trace is replaced before open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawlore-shadow-audit-swap-"));
  const traceFile = join(directory, "runtime-shadow.jsonl");
  const replacement = join(directory, "replacement.jsonl");
  try {
    await writeFile(traceFile, `${JSON.stringify(receipt())}\n`, { mode: 0o600 });
    await writeFile(replacement, `${JSON.stringify(receipt({ traceId: "clawlore-shadow-replacement00001" }))}\n`, { mode: 0o600 });
    await chmod(traceFile, 0o600);
    await chmod(replacement, 0o600);
    if (process.platform === "win32") {
      enforcePrivatePath(directory, { kind: "directory" });
      enforcePrivatePath(traceFile, { kind: "file" });
      enforcePrivatePath(replacement, { kind: "file" });
    }
    const result = await auditShadowObservation(traceFile, {
      async beforeOpen() {
        await rm(traceFile, { force: true });
        await rename(replacement, traceFile);
      },
    });
    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["trace_private_read_failed"]);
    assert.equal(result.sampleCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("shadow observation receipt is private and never authorizes V2 writes", async () => {
  await withTrace([receipt()], 0o600, async (traceFile) => {
    const audit = await auditShadowObservation(traceFile);
    const receiptFile = join(tmpdir(), `clawlore-shadow-receipt-${process.pid}-${Date.now()}.json`);
    try {
      const receipt = await writeShadowObservationReceipt(
        receiptFile,
        audit,
        () => new Date("2026-07-12T06:45:00.000Z"),
      );
      verifyPrivatePath(receiptFile, { kind: "file" });
      assert.equal(receipt.decision, "observe");
      assert.deepEqual(receipt.safety, {
        writesEnabled: false,
        promptMutationEnabled: false,
        contextEngineEnabled: false,
        authorizesV2Writes: false,
        boundedPlanValidationRequired: true,
      });
      const serialized = await readFile(receiptFile, "utf8");
      assert.equal(serialized.includes("traceId"), false);
      assert.equal(serialized.includes("principalHash"), false);
      assert.equal(serialized.includes("messageText"), false);
    } finally {
      await rm(receiptFile, { force: true });
    }
  });
});
