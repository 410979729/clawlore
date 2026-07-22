#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeLiveCandidateGovernanceArchiveV1 } = jiti(
  "../src/v2/operator/live-candidate-governance-archive-apply.ts",
);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${token ?? ""}`);
    args[token.slice(2)] = value;
  }
  for (const required of ["source", "plan", "acceptance", "snapshot-archive", "snapshot-receipt", "rollout-id", "plan-digest", "output"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receipt = await executeLiveCandidateGovernanceArchiveV1({
  sourcePath: resolve(args.source),
  planPath: resolve(args.plan),
  acceptancePath: resolve(args.acceptance),
  snapshotArchivePath: resolve(args["snapshot-archive"]),
  snapshotReceiptPath: resolve(args["snapshot-receipt"]),
  rolloutId: args["rollout-id"],
  planDigest: args["plan-digest"],
});
await writeFile(resolve(args.output), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: receipt.status, idempotentReplay: receipt.idempotentReplay, rowsChangedThisRun: receipt.archive.rowsChangedThisRun })}\n`);
