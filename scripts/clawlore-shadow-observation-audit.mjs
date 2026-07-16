import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { enforcePrivatePath } = jiti("../src/file-privacy.ts");

const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "traceId",
  "status",
  "principalHash",
  "ingressKind",
  "visibility",
  "retrievalInvoked",
  "candidateCount",
  "selectedCount",
  "usedTokens",
  "stages",
  "rejectionReasons",
  "comparison",
  "errorCode",
  "createdAt",
]);

const STAGE_KEYS = new Set(["stage", "outcome", "detail"]);
const COMPARISON_KEYS = new Set([
  "status",
  "primaryCandidateCount",
  "comparisonCandidateCount",
  "overlapRatio",
  "rankAgreement",
  "primaryLatencyMs",
  "comparisonLatencyMs",
  "primaryIdsDigest",
  "comparisonIdsDigest",
]);

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function stagePassed(receipt, stageName) {
  return receipt.stages.some((stage) => stage.stage === stageName && stage.outcome === "pass");
}

function validateReceipt(receipt, lineNumber) {
  const issues = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return [`line_${lineNumber}:not_an_object`];
  }
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_KEYS.has(key)) issues.push(`line_${lineNumber}:unexpected_receipt_key:${key}`);
  }
  if (receipt.schemaVersion !== 1) issues.push(`line_${lineNumber}:schema_version`);
  if (!Array.isArray(receipt.stages)) issues.push(`line_${lineNumber}:stages_not_array`);
  for (const stage of Array.isArray(receipt.stages) ? receipt.stages : []) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      issues.push(`line_${lineNumber}:stage_not_object`);
      continue;
    }
    for (const key of Object.keys(stage)) {
      if (!STAGE_KEYS.has(key)) issues.push(`line_${lineNumber}:unexpected_stage_key:${key}`);
    }
  }
  for (const field of ["candidateCount", "selectedCount", "usedTokens"]) {
    if (!Number.isInteger(receipt[field]) || receipt[field] < 0) {
      issues.push(`line_${lineNumber}:invalid_${field}`);
    }
  }
  if (typeof receipt.retrievalInvoked !== "boolean") {
    issues.push(`line_${lineNumber}:invalid_retrievalInvoked`);
  }
  if (receipt.ingressKind !== undefined
      && !["direct", "group", "channel", "unknown"].includes(receipt.ingressKind)) {
    issues.push(`line_${lineNumber}:invalid_ingressKind`);
  }
  if (receipt.visibility !== undefined
      && !["private", "conversation", "project", "team", "global"].includes(receipt.visibility)) {
    issues.push(`line_${lineNumber}:invalid_visibility`);
  }
  if (receipt.comparison !== undefined) {
    if (!receipt.comparison || typeof receipt.comparison !== "object" || Array.isArray(receipt.comparison)) {
      issues.push(`line_${lineNumber}:comparison_not_object`);
    } else {
      for (const key of Object.keys(receipt.comparison)) {
        if (!COMPARISON_KEYS.has(key)) issues.push(`line_${lineNumber}:unexpected_comparison_key:${key}`);
      }
      if (!["completed", "failed"].includes(receipt.comparison.status)) {
        issues.push(`line_${lineNumber}:invalid_comparison_status`);
      }
      for (const field of ["primaryCandidateCount", "comparisonCandidateCount", "primaryLatencyMs", "comparisonLatencyMs"]) {
        if (!Number.isInteger(receipt.comparison[field]) || receipt.comparison[field] < 0) {
          issues.push(`line_${lineNumber}:invalid_comparison_${field}`);
        }
      }
      for (const field of ["overlapRatio", "rankAgreement"]) {
        if (typeof receipt.comparison[field] !== "number"
            || receipt.comparison[field] < 0 || receipt.comparison[field] > 1) {
          issues.push(`line_${lineNumber}:invalid_comparison_${field}`);
        }
      }
      for (const field of ["primaryIdsDigest", "comparisonIdsDigest"]) {
        if (!/^[a-f0-9]{64}$/.test(String(receipt.comparison[field] ?? ""))) {
          issues.push(`line_${lineNumber}:invalid_comparison_${field}`);
        }
      }
    }
  }
  return issues;
}

export async function auditShadowObservation(traceFile) {
  const [metadata, raw] = await Promise.all([stat(traceFile), readFile(traceFile, "utf8")]);
  const mode = metadata.mode & 0o777;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const receipts = [];
  const issues = [];

  for (const [index, line] of lines.entries()) {
    try {
      const receipt = JSON.parse(line);
      issues.push(...validateReceipt(receipt, index + 1));
      receipts.push(receipt);
    } catch {
      issues.push(`line_${index + 1}:invalid_json`);
    }
  }

  if ((mode & 0o077) !== 0) issues.push(`trace_permissions:${mode.toString(8)}`);

  const validReceipts = receipts.filter((receipt) => receipt && typeof receipt === "object");
  const acceptedSamples = validReceipts.filter((receipt) =>
    receipt.status === "completed"
    && receipt.retrievalInvoked === true
    && stagePassed(receipt, "identity")
    && stagePassed(receipt, "policy_preflight"));
  const acceptedDirectSamples = acceptedSamples.filter((receipt) =>
    receipt.ingressKind === "direct" && receipt.visibility === "private");
  const acceptedGroupSamples = acceptedSamples.filter((receipt) =>
    receipt.ingressKind === "group" && receipt.visibility === "conversation");
  const positiveCandidateSamples = acceptedSamples.filter((receipt) => receipt.candidateCount > 0);
  const comparisonSamples = acceptedSamples
    .map((receipt) => receipt.comparison)
    .filter((comparison) => comparison?.status === "completed");
  const gateBlockers = [];
  if (issues.length > 0) gateBlockers.push("trace_integrity_failed");
  if (validReceipts.some((receipt) => receipt.status === "failed")) gateBlockers.push("failed_receipt_present");
  if (acceptedDirectSamples.length < 3) gateBlockers.push("insufficient_direct_samples");
  if (acceptedGroupSamples.length < 1) gateBlockers.push("group_boundary_sample_missing");
  if (positiveCandidateSamples.length < 1) gateBlockers.push("positive_candidate_sample_missing");
  const latest = validReceipts.at(-1);

  return {
    schemaVersion: 1,
    status: issues.length === 0 ? "pass" : "fail",
    traceMode: mode.toString(8).padStart(3, "0"),
    sampleCount: validReceipts.length,
    statuses: countBy(validReceipts.map((receipt) => String(receipt.status))),
    ingressKinds: countBy(validReceipts.map((receipt) => String(receipt.ingressKind ?? "legacy_unknown"))),
    visibilities: countBy(validReceipts.map((receipt) => String(receipt.visibility ?? "legacy_unknown"))),
    retrievalInvokedCount: validReceipts.filter((receipt) => receipt.retrievalInvoked === true).length,
    identityPassCount: validReceipts.filter((receipt) => stagePassed(receipt, "identity")).length,
    policyPassCount: validReceipts.filter((receipt) => stagePassed(receipt, "policy_preflight")).length,
    acceptedSampleCount: acceptedSamples.length,
    acceptedDirectSampleCount: acceptedDirectSamples.length,
    acceptedGroupSampleCount: acceptedGroupSamples.length,
    positiveCandidateSampleCount: positiveCandidateSamples.length,
    maxCandidateCount: Math.max(0, ...validReceipts.map((receipt) => receipt.candidateCount ?? 0)),
    maxSelectedCount: Math.max(0, ...validReceipts.map((receipt) => receipt.selectedCount ?? 0)),
    comparison: {
      completedSamples: comparisonSamples.length,
      failedSamples: acceptedSamples.filter((receipt) => receipt.comparison?.status === "failed").length,
      minimumOverlapRatio: comparisonSamples.length > 0
        ? Math.min(...comparisonSamples.map((comparison) => comparison.overlapRatio))
        : null,
      minimumRankAgreement: comparisonSamples.length > 0
        ? Math.min(...comparisonSamples.map((comparison) => comparison.rankAgreement))
        : null,
      maximumPrimaryLatencyMs: Math.max(0, ...comparisonSamples.map((comparison) => comparison.primaryLatencyMs)),
      maximumComparisonLatencyMs: Math.max(0, ...comparisonSamples.map((comparison) => comparison.comparisonLatencyMs)),
    },
    latest: latest ? {
      status: latest.status,
      retrievalInvoked: latest.retrievalInvoked,
      candidateCount: latest.candidateCount,
      selectedCount: latest.selectedCount,
      ingressKind: latest.ingressKind ?? "legacy_unknown",
      visibility: latest.visibility ?? "legacy_unknown",
      createdAt: latest.createdAt,
    } : null,
    goNoGo: {
      decision: gateBlockers.length === 0 ? "go" : "observe",
      thresholds: {
        directSamples: 3,
        groupSamples: 1,
        positiveCandidateSamples: 1,
      },
      blockers: gateBlockers,
    },
    issues,
  };
}

export async function writeShadowObservationReceipt(receiptFile, audit, now = () => new Date()) {
  const receipt = {
    schemaVersion: 1,
    kind: "clawlore_shadow_observation_v1",
    generatedAt: now().toISOString(),
    decision: audit.goNoGo.decision,
    thresholds: audit.goNoGo.thresholds,
    blockers: audit.goNoGo.blockers,
    observation: {
      traceIntegrityStatus: audit.status,
      traceMode: audit.traceMode,
      sampleCount: audit.sampleCount,
      acceptedDirectSampleCount: audit.acceptedDirectSampleCount,
      acceptedGroupSampleCount: audit.acceptedGroupSampleCount,
      positiveCandidateSampleCount: audit.positiveCandidateSampleCount,
      maxCandidateCount: audit.maxCandidateCount,
      maxSelectedCount: audit.maxSelectedCount,
      comparison: audit.comparison,
      latest: audit.latest,
      issues: audit.issues,
    },
    safety: {
      writesEnabled: false,
      promptMutationEnabled: false,
      contextEngineEnabled: false,
      authorizesV2Writes: false,
      boundedPlanValidationRequired: true,
    },
  };
  const directory = dirname(receiptFile);
  const temporary = `${receiptFile}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    enforcePrivatePath(temporary, { kind: "file" });
    await rename(temporary, receiptFile);
    await chmod(receiptFile, 0o600);
    enforcePrivatePath(receiptFile, { kind: "file" });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return receipt;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const traceFile = argument("--trace-file");
  const receiptFile = argument("--receipt-file");
  if (!traceFile) {
    process.stderr.write("usage: node scripts/clawlore-shadow-observation-audit.mjs --trace-file <path> [--receipt-file <path>]\n");
    process.exitCode = 2;
  } else {
    const result = await auditShadowObservation(traceFile);
    if (receiptFile) await writeShadowObservationReceipt(receiptFile, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  }
}
