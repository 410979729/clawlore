#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLivePostAssignmentCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-assignment-candidate-plan.ts");

function parseArgs(argv) {
  const args = {
    "prior-assignment-plan": [],
    "prior-assignment-acceptance": [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    const key = token.slice(2);
    if (key === "prior-assignment-plan" || key === "prior-assignment-acceptance") {
      args[key].push(value);
    } else {
      args[key] = value;
    }
    index += 1;
  }
  for (const required of [
    "source", "assignment-plan", "assignment-acceptance", "delta-acceptance", "rollout-id", "receipt",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (args["prior-assignment-plan"].length !== args["prior-assignment-acceptance"].length) {
    throw new Error("prior assignment plans and acceptances must be paired");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = createLivePostAssignmentCandidatePlanV1({
  sourcePath: resolve(args.source),
  assignmentPlanPath: resolve(args["assignment-plan"]),
  assignmentAcceptancePath: resolve(args["assignment-acceptance"]),
  priorAssignmentControls: args["prior-assignment-plan"].map((planPath, index) => ({
    planPath: resolve(planPath),
    acceptancePath: resolve(args["prior-assignment-acceptance"][index]),
  })),
  deltaAcceptancePath: resolve(args["delta-acceptance"]),
  proposedRolloutId: args["rollout-id"],
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  proposedRolloutId: plan.proposedRolloutId,
  readOnly: plan.readOnly,
  assignment: plan.assignment,
  delta: plan.delta,
  source: plan.source,
  counts: plan.candidatePromotionPlan.counts,
  planDigest: plan.candidatePromotionPlan.planDigest,
  decision: plan.decision,
  authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
})}\n`);
