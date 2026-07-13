#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { acceptLiveCandidateCompanionDispositionPlanV1 } =
  jiti("../src/v2/operator/live-candidate-companion-disposition.ts");

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
  for (const required of ["source", "plan", "plan-digest", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const acceptance = acceptLiveCandidateCompanionDispositionPlanV1({
  sourcePath: resolve(args.source),
  planPath: resolve(args.plan),
  planDigest: args["plan-digest"],
});
await writeFile(receiptPath, `${JSON.stringify(acceptance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(acceptance)}\n`);
