#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLivePrincipalScopePlanV1 } =
  jiti("../src/v2/operator/live-principal-scope-plan.ts");

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
  for (const required of ["source", "session-key", "source-scope", "migration-id", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const plan = await createLivePrincipalScopePlanV1({
  sourcePath: resolve(args.source),
  targetSessionKey: args["session-key"],
  sourceScope: args["source-scope"],
  proposedMigrationId: args["migration-id"],
});
await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
await chmod(dirname(receiptPath), 0o700);
await writeFile(receiptPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: plan.phase,
  proposedMigrationId: plan.proposedMigrationId,
  source: plan.source,
  lanes: plan.lanes,
  summary: plan.summary,
  decision: plan.decision,
  planDigest: plan.planDigest,
})}\n`);
