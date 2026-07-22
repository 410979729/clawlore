#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveCandidateGovernanceArchivePlanV1 } = jiti(
  "../src/v2/operator/live-candidate-governance-archive-plan.ts",
);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${token ?? ""}`);
    args[token.slice(2)] = value;
  }
  for (const required of ["source", "prior-adjudication", "appended-decisions", "archive-id", "output"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const plan = createLiveCandidateGovernanceArchivePlanV1({
  sourcePath: resolve(args.source),
  priorAdjudicationPath: resolve(args["prior-adjudication"]),
  appendedDecisionPath: resolve(args["appended-decisions"]),
  proposedArchiveId: args["archive-id"],
});
await writeFile(resolve(args.output), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "pass", rows: plan.targetRows, planDigest: plan.planDigest })}\n`);
