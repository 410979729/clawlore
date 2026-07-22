#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAppendedCandidateArchiveDecisionControlV1 } = jiti(
  "../src/v2/operator/appended-candidate-archive-decisions.ts",
);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${token ?? ""}`);
    args[token.slice(2)] = value;
  }
  for (const required of ["source", "output", "decision-id", "source-rollout-id", "explicit-manual-content-digest", "unknown-legacy-content-digest"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const control = createAppendedCandidateArchiveDecisionControlV1({
  sourcePath: resolve(args.source),
  decisionId: args["decision-id"],
  sourceRolloutId: args["source-rollout-id"],
  explicitManualContentDigest: args["explicit-manual-content-digest"],
  unknownLegacyContentDigest: args["unknown-legacy-content-digest"],
});
await writeFile(resolve(args.output), `${JSON.stringify(control, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "pass", rows: control.summary.reviewedRows, decisionDigest: control.decisionDigest })}\n`);
