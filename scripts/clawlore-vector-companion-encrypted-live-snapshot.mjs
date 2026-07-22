#!/usr/bin/env node
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAndVerifyVectorCompanionLiveEncryptedSnapshotV2 } = jiti(
  "../src/v2/operator/vector-companion-live-encrypted-snapshot.ts",
);

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
  for (const required of ["source-root", "archive", "restore-test-root", "receipt", "key-id", "secret-ref"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receipt = await createAndVerifyVectorCompanionLiveEncryptedSnapshotV2({
  sourceRoot: resolve(args["source-root"]),
  archivePath: resolve(args.archive),
  restoreTestRoot: resolve(args["restore-test-root"]),
  receiptPath: resolve(args.receipt),
  keyId: args["key-id"],
  secretRefPath: resolve(args["secret-ref"]),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
