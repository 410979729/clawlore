#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveCandidateDurableRewriteProposalPlanV1 } =
  jiti("../src/v2/operator/live-candidate-durable-rewrite-proposal.ts");

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
  for (const required of ["source", "adjudication-preview", "rewrite-payload", "rewrite-id", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = createLiveCandidateDurableRewriteProposalPlanV1({
  sourcePath: resolve(args.source),
  adjudicationPreviewPath: resolve(args["adjudication-preview"]),
  rewritePayloadPath: resolve(args["rewrite-payload"]),
  proposedRewriteId: args["rewrite-id"],
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  readOnly: plan.readOnly,
  queryOnly: plan.queryOnly,
  summary: plan.summary,
  planDigest: plan.planDigest,
  authorizesContentRewrite: plan.authorizesContentRewrite,
  authorizesSoftArchive: plan.authorizesSoftArchive,
  authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
  requiresFreshEncryptedSnapshot: plan.requiresFreshEncryptedSnapshot,
  requiresSeparateExactApply: plan.requiresSeparateExactApply,
})}\n`);
