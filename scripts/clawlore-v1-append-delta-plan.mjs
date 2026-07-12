#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveV1AppendDeltaPlanV1 } = jiti("../src/v2/operator/live-v1-append-delta-plan.ts");

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
  for (const required of ["source", "baseline", "rollout-id", "tenant-id", "agent-id", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = await createLiveV1AppendDeltaPlanV1({
  sourcePath: resolve(args.source),
  baselineReceiptPath: resolve(args.baseline),
  proposedRolloutId: args["rollout-id"],
  defaults: {
    tenantId: args["tenant-id"],
    agentId: args["agent-id"],
    ...(args["workspace-id"] ? { workspaceId: args["workspace-id"] } : {}),
  },
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  proposedRolloutId: plan.proposedRolloutId,
  readOnly: plan.readOnly,
  baseline: plan.baseline,
  source: plan.source,
  proposed: {
    activeRows: plan.proposed.activeRows,
    candidateRows: plan.proposed.candidateRows,
    archivedRows: plan.proposed.archivedRows,
    classifications: plan.proposed.classifications,
    verifications: plan.proposed.verifications,
    verificationDebt: plan.proposed.verificationDebt,
    reviewRequiredRows: plan.proposed.reviewRequiredRows,
    invalidMetadataRows: plan.proposed.invalidMetadataRows,
    planDigest: plan.proposed.planDigest,
  },
  projectionWork: plan.projectionWork,
  decision: plan.decision,
  authorizesDeltaWrite: plan.authorizesDeltaWrite,
})}\n`);
