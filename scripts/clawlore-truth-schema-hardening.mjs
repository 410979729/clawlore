#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyTruthSchemaHardeningV1,
  previewTruthSchemaHardeningV1,
} = jiti("../src/v2/operator/truth-schema-hardening.ts");

function parseArgs(argv) {
  const [mode, ...tokens] = argv;
  if (mode !== "preview" && mode !== "apply") {
    throw new Error("first argument must be preview or apply");
  }
  const args = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  if (!args.db) throw new Error("--db is required");
  if (mode === "apply" && !args["expected-plan-digest"]) {
    throw new Error("--expected-plan-digest is required for apply");
  }
  if (mode === "apply" && !args.receipt) {
    throw new Error("--receipt is required for apply");
  }
  return { mode, args };
}

const { mode, args } = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db);
if (mode === "preview") {
  process.stdout.write(`${JSON.stringify(previewTruthSchemaHardeningV1(dbPath), null, 2)}\n`);
} else {
  const receipt = applyTruthSchemaHardeningV1({
    path: dbPath,
    expectedPlanDigest: args["expected-plan-digest"],
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(resolve(args.receipt), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(serialized);
}
