#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  for (const required of [
    "content-quality-preview",
    "rewrite-plan",
    "rewrite-apply-receipt",
    "rewrite-postcheck",
    "transient-indices",
    "canonical-policy-indices",
    "volatile-indices",
    "semantic-redundancy-indices",
    "receipt",
  ]) if (!args[required]) throw new Error(`--${required} is required`);
  return args;
}

async function privateControl(path) {
  const resolved = resolve(path);
  const info = await stat(resolved);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > 5 * 1024 * 1024) {
    throw new Error("operator decision source must be a non-empty owner-only file");
  }
  const bytes = await readFile(resolved);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
}

function indices(value) {
  const parsed = new Set(value.split(",").map((part) => Number(part.trim())));
  if ([...parsed].some((index) => !Number.isInteger(index) || index < 1 || index > 58)) {
    throw new Error("operator decision index is outside the exact 1..58 review set");
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const content = await privateControl(args["content-quality-preview"]);
const rewrite = await privateControl(args["rewrite-plan"]);
const apply = await privateControl(args["rewrite-apply-receipt"]);
const postcheck = await privateControl(args["rewrite-postcheck"]);
if (
  content.value.phase !== "clawlore-candidate-content-quality-review-plan"
  || content.value.rows?.length !== 90
  || rewrite.value.phase !== "clawlore-candidate-unsafe-trace-rewrite-proposal-plan"
  || rewrite.value.rows?.length !== 32
  || apply.value.phase !== "clawlore-candidate-unsafe-trace-rewrite-live-apply"
  || apply.value.planDigest !== rewrite.value.planDigest
  || apply.value.planSha256 !== rewrite.sha256
  || postcheck.value.phase !== "clawlore-candidate-unsafe-trace-rewrite-postcheck"
  || postcheck.value.applyReceiptSha256 !== apply.sha256
) throw new Error("operator decision sources are invalid or unbound");

const rewritten = new Set(rewrite.value.rows.map((row) => row.itemIdSha256));
const remaining = content.value.rows.filter((row) => !rewritten.has(row.itemIdSha256));
if (
  rewritten.size !== 32
  || remaining.length !== 58
  || remaining.filter((row) => row.lane === "exact_duplicate_review").length !== 2
  || remaining.filter((row) => row.lane === "manual_semantic_review").length !== 56
) throw new Error("operator decision sources do not yield the exact 2 duplicate / 56 semantic set");

const basisGroups = [
  ["transient_conversation", indices(args["transient-indices"])],
  ["covered_by_canonical_policy", indices(args["canonical-policy-indices"])],
  ["volatile_runtime_snapshot", indices(args["volatile-indices"])],
  ["semantic_redundancy", indices(args["semantic-redundancy-indices"])],
];
const selected = new Set();
for (const [, group] of basisGroups) {
  for (const index of group) {
    if (selected.has(index)) throw new Error("operator decision archive groups must not overlap");
    selected.add(index);
  }
}
const basisFor = (index) => basisGroups.find(([, group]) => group.has(index))?.[0];
const decisions = remaining.map((row, offset) => {
  const index = offset + 1;
  const archiveBasis = basisFor(index);
  const disposition = archiveBasis ? "propose_soft_archive" : "retain_candidate_for_verification";
  const basis = archiveBasis ?? (row.category === "preference"
    ? "durable_preference_requires_verification"
    : row.category === "decision"
      ? "durable_decision_requires_verification"
      : "durable_content_requires_verification");
  return {
    itemIdSha256: row.itemIdSha256,
    disposition,
    basis,
    evidenceDigest: sha256(`private-operator-review:${index}:${row.itemIdSha256}:${basis}`),
  };
});
const core = {
  contentQualityPlanDigest: content.value.planDigest,
  contentQualityPreviewSha256: content.sha256,
  rewritePlanDigest: rewrite.value.planDigest,
  rewritePlanSha256: rewrite.sha256,
  rewriteApplyReceiptSha256: apply.sha256,
  rewritePostcheckSha256: postcheck.sha256,
  decisions,
};
const control = {
  schemaVersion: 1,
  phase: "clawlore-post-rewrite-operator-decisions",
  createdAt: new Date().toISOString(),
  ...core,
  readOnly: true,
  containsMemoryContent: false,
  containsRawIdentifiers: false,
  authorizesSoftArchive: false,
  authorizesContentRewrite: false,
  authorizesLifecycleMutation: false,
  authorizesVerificationMutation: false,
  decisionDigest: sha256(JSON.stringify(core)),
};
const receiptPath = resolve(args.receipt);
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(control, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: control.phase,
  targetRows: decisions.length,
  proposedSoftArchiveRows: decisions.filter((row) => row.disposition === "propose_soft_archive").length,
  retainedForVerificationRows: decisions.filter((row) => row.disposition === "retain_candidate_for_verification").length,
  decisionDigest: control.decisionDigest,
  authorizesSoftArchive: control.authorizesSoftArchive,
  authorizesLifecycleMutation: control.authorizesLifecycleMutation,
})}\n`);
