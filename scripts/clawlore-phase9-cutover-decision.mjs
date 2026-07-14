#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveClawLorePhase9NoCutoverReceiptV1 } =
  jiti("../src/v2/operator/live-phase9-cutover-decision.ts");

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
    "source",
    "candidate-baseline",
    "phase8g-plan",
    "rewrite-postcheck",
    "config",
    "receipt",
  ]) if (!args[required]) throw new Error(`--${required} is required`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const receipt = createLiveClawLorePhase9NoCutoverReceiptV1({
  sourcePath: resolve(args.source),
  candidateBaselinePath: resolve(args["candidate-baseline"]),
  phase8gPlanPath: resolve(args["phase8g-plan"]),
  rewritePostcheckPath: resolve(args["rewrite-postcheck"]),
  configPath: resolve(args.config),
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: receipt.phase,
  decision: receipt.decision.decision,
  blockers: receipt.decision.blockers,
  source: receipt.source,
  runtime: receipt.runtime,
  phase8g: receipt.phase8g,
  planDigest: receipt.planDigest,
  authorizesLifecycleMutation: receipt.decision.authorizesLifecycleMutation,
  authorizesFinalRecall: receipt.decision.authorizesFinalRecall,
})}\n`);
