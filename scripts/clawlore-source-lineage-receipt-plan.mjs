#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveSourceLineageReceiptPlanV1 } =
  jiti("../src/v2/operator/live-source-lineage-receipt-plan.ts");

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
  for (const required of ["source", "remediation-preview", "rollout-id", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = createLiveSourceLineageReceiptPlanV1({
  sourcePath: resolve(args.source),
  remediationPreviewPath: resolve(args["remediation-preview"]),
  proposedRolloutId: args["rollout-id"],
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  readOnly: plan.readOnly,
  sourceLineageOnly: plan.sourceLineageOnly,
  summary: plan.summary,
  classifications: plan.classifications,
  decisions: plan.decisions,
  planDigest: plan.planDigest,
  authorizesEvidenceWrite: plan.authorizesEvidenceWrite,
  authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
  authorizesVerificationMutation: plan.authorizesVerificationMutation,
})}\n`);
