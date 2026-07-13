#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url);
const { normalizeCandidateContentV1 } =
  jiti("../src/v2/application/candidate-content-quality-review.ts");
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
  for (const required of ["source", "plan", "rewrite-payload", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

async function privateJson(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > 5 * 1024 * 1024) {
    throw new Error("durable rewrite acceptance input must be owner-only JSON");
  }
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes.toString("utf8")), bytes, sha256: sha256(bytes) };
}

function sourceState(db) {
  const scalar = (sql) => Number(Object.values(db.prepare(sql).get())[0] ?? 0);
  return {
    v1Rows: scalar("SELECT COUNT(*) FROM memory_truth"),
    v2Rows: scalar("SELECT COUNT(*) FROM memory_items"),
    candidateRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    activeRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    archivedRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    compatibilityRows: scalar("SELECT COUNT(*) FROM memory_fts_compat_v2"),
    currentFtsRows: scalar("SELECT COUNT(*) FROM memory_fts_v2"),
    vectorRows: scalar("SELECT COUNT(*) FROM memory_vector_projection_v2"),
    relationRows: scalar("SELECT COUNT(*) FROM memory_relation_projection_v2"),
    pendingOutboxRows: scalar("SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
  };
}

const args = parseArgs(process.argv.slice(2));
const sourcePath = resolve(args.source);
const planPath = resolve(args.plan);
const payloadPath = resolve(args["rewrite-payload"]);
const receiptPath = resolve(args.receipt);
const loadedPlan = await privateJson(planPath);
const loadedPayload = await privateJson(payloadPath);
const plan = loadedPlan.value;
const payload = loadedPayload.value;

if (
  plan?.schemaVersion !== 1
  || plan.phase !== "clawlore-candidate-durable-rewrite-proposal-plan"
  || plan.readOnly !== true
  || plan.queryOnly !== true
  || plan.containsProposedMemoryContent !== false
  || plan.containsOriginalMemoryContent !== false
  || plan.containsTranscriptContent !== false
  || plan.emitsRawIdentifiers !== false
  || plan.authorizesContentRewrite !== false
  || plan.authorizesSoftArchive !== false
  || plan.authorizesHardDelete !== false
  || plan.authorizesLifecycleMutation !== false
  || plan.authorizesVerificationMutation !== false
  || plan.authorizesContextEngine !== false
  || plan.authorizesPromptMutation !== false
  || plan.authorizesFinalRecall !== false
  || plan.requiresFreshEncryptedSnapshot !== true
  || plan.requiresSeparateExactApply !== true
) throw new Error("durable rewrite acceptance plan contract is invalid");

const planCore = {
  proposedRewriteId: plan.proposedRewriteId,
  adjudicationPlanDigest: plan.adjudicationPlanDigest,
  adjudicationPreviewSha256: plan.adjudicationPreviewSha256,
  rewritePayloadDigest: plan.rewritePayloadDigest,
  rewritePayloadSha256: plan.rewritePayloadSha256,
  adjudicationSource: plan.adjudicationSource,
  appendOnlySourceExtensionRows: plan.appendOnlySourceExtensionRows,
  source: plan.source,
  summary: plan.summary,
  groups: plan.groups,
  rows: plan.rows,
};
if (sha256(JSON.stringify(planCore)) !== plan.planDigest) {
  throw new Error("durable rewrite acceptance plan digest is invalid");
}
const payloadCore = {
  adjudicationPlanDigest: payload.adjudicationPlanDigest,
  adjudicationPreviewSha256: payload.adjudicationPreviewSha256,
  specifications: payload.specifications,
};
if (
  sha256(JSON.stringify(payloadCore)) !== payload.payloadDigest
  || loadedPayload.sha256 !== plan.rewritePayloadSha256
  || payload.payloadDigest !== plan.rewritePayloadDigest
) throw new Error("durable rewrite acceptance payload binding is invalid");

const serializedPlan = loadedPlan.bytes.toString("utf8");
for (const specification of payload.specifications) {
  if (serializedPlan.includes(specification.proposedContent)) {
    throw new Error("durable rewrite plan leaked proposed memory content");
  }
  const group = plan.groups.find((candidate) => candidate.normalizedContentDigest === specification.normalizedContentDigest);
  if (
    !group
    || group.representativeItemIdSha256 !== specification.representativeItemIdSha256
    || group.proposedContentDigest !== sha256(specification.proposedContent)
    || group.proposedNormalizedContentDigest !== sha256(normalizeCandidateContentV1(specification.proposedContent))
    || group.captureSafetyAllowed !== true
    || group.corpusCollisionRows !== 0
  ) throw new Error("durable rewrite acceptance proposal binding is invalid");
}
for (const marker of ["legacy:", "revision:", "Command hints:", "Files:\\n", "/home/", "/tmp/"]) {
  if (serializedPlan.includes(marker)) throw new Error("durable rewrite plan leaked raw trace material");
}

const db = new DatabaseSync(sourcePath, { readOnly: true });
let live;
let liveBindingMismatches = 0;
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
  live = sourceState(db);
  if (JSON.stringify(live) !== JSON.stringify(plan.source)) {
    throw new Error("durable rewrite live source changed after planning");
  }
  const rows = db.prepare("SELECT item_id,current_revision_id,content,category,lifecycle,verification FROM memory_items").all();
  const liveByHash = new Map(rows.map((row) => [sha256(row.item_id), row]));
  for (const planned of plan.rows) {
    const row = liveByHash.get(planned.itemIdSha256);
    if (
      !row
      || sha256(row.current_revision_id) !== planned.currentRevisionIdSha256
      || sha256(row.content) !== planned.contentDigest
      || sha256(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
      || row.category !== planned.category
      || row.lifecycle !== "candidate"
      || row.verification !== "unverified"
    ) liveBindingMismatches++;
  }
} finally {
  db.close();
}
if (liveBindingMismatches !== 0) throw new Error("durable rewrite live target binding changed after planning");

const receipt = {
  schemaVersion: 1,
  phase: "clawlore-candidate-durable-rewrite-proposal-acceptance",
  acceptedAt: new Date().toISOString(),
  status: "pass",
  planDigest: plan.planDigest,
  planSha256: loadedPlan.sha256,
  rewritePayloadDigest: payload.payloadDigest,
  rewritePayloadSha256: loadedPayload.sha256,
  summary: plan.summary,
  live,
  liveBindingMismatches,
  proposedContentLeak: false,
  rawTraceOrIdentifierLeak: false,
  authorizesContentRewrite: false,
  authorizesSoftArchive: false,
  authorizesLifecycleMutation: false,
  requiresFreshEncryptedSnapshot: true,
  requiresSeparateExactApply: true,
};
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
