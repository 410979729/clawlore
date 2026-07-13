#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLivePostCompanionArchiveCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-companion-archive-candidate-plan.ts");

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
    "source", "prior-baseline", "companion-plan", "apply-receipt", "postcheck",
    "plan-digest", "rollout-id", "receipt",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = createLivePostCompanionArchiveCandidatePlanV1({
  sourcePath: resolve(args.source),
  priorBaselinePath: resolve(args["prior-baseline"]),
  companionPlanPath: resolve(args["companion-plan"]),
  applyReceiptPath: resolve(args["apply-receipt"]),
  postcheckPath: resolve(args.postcheck),
  planDigest: args["plan-digest"],
  proposedRolloutId: args["rollout-id"],
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  proposedRolloutId: plan.proposedRolloutId,
  readOnly: plan.readOnly,
  source: plan.source,
  counts: plan.candidatePromotionPlan.counts,
  planDigest: plan.candidatePromotionPlan.planDigest,
  archiveRebase: plan.archiveRebase,
  decision: plan.decision,
  authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
})}\n`);
