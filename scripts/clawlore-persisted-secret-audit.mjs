#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findSecret } from "../dist/src/secret-redaction.js";
import {
  PERSISTED_SECRET_VECTOR_FIELDS,
} from "../dist/src/persisted-secret-policy.js";
import { scanPersistedSecretDatabase } from "../dist/src/persisted-secret-scan.js";
import {
  inspectOwnerOnlySqliteFamily,
  inspectOwnerOnlyTree,
} from "../dist/src/persisted-store-permissions.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function auditPersistedSecretDatabase({ path, kind }) {
  assert.ok(["memory", "conversation"].includes(kind), `unsupported persisted-secret database kind: ${kind}`);
  const canonicalPath = await realpath(resolve(path));
  const info = await stat(canonicalPath);
  assert.equal(info.isFile(), true, `${kind} database must be a regular file`);
  const db = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    const { summary } = scanPersistedSecretDatabase(db, kind);
    const permissions = inspectOwnerOnlySqliteFamily(canonicalPath);
    return {
      kind,
      databasePathSha256: sha256(canonicalPath),
      ownerOnlyMode: permissions.ownerOnly,
      permissionEntries: {
        files: permissions.files,
        directories: permissions.directories,
        unsafe: permissions.unsafeEntries,
      },
      ...summary,
    };
  } finally {
    db.close();
  }
}

export async function auditPersistedSecretLanceDb({ path }) {
  const canonicalPath = await realpath(resolve(path));
  const info = await stat(canonicalPath);
  assert.equal(info.isDirectory(), true, "LanceDB path must be a directory");
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(canonicalPath);
  const table = await db.openTable("memories");
  const rows = await table.query().select(["id", ...PERSISTED_SECRET_VECTOR_FIELDS]).toArray();
  const permissions = inspectOwnerOnlyTree(canonicalPath);
  const rowHits = new Set();
  const flaggedPayloads = new Set();
  const patternCounts = {};
  const fieldCounts = {};
  let secretBearingFields = 0;
  try {
    for (const row of rows) {
      for (const field of PERSISTED_SECRET_VECTOR_FIELDS) {
        const value = row[field];
        if (value === null || value === undefined || value === "") continue;
        const text = String(value);
        const secret = findSecret(text);
        if (!secret) continue;
        rowHits.add(sha256(String(row.id)));
        flaggedPayloads.add(sha256(text));
        secretBearingFields += 1;
        fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
        patternCounts[secret.name] = (patternCounts[secret.name] ?? 0) + 1;
      }
    }
  } finally {
    await table.close?.();
    await db.close?.();
  }
  return {
    kind: "vector",
    databasePathSha256: sha256(canonicalPath),
    ownerOnlyMode: permissions.ownerOnly,
    permissionEntries: {
      files: permissions.files,
      directories: permissions.directories,
      unsafe: permissions.unsafeEntries,
    },
    secretBearingRows: rowHits.size,
    secretBearingFields,
    uniqueFlaggedPayloads: flaggedPayloads.size,
    findings: secretBearingFields === 0 ? [] : [{
      table: "memories",
      scannedRows: rows.length,
      secretBearingRows: rowHits.size,
      secretBearingFields,
      fieldCounts,
      patternCounts,
    }],
  };
}

export async function auditPersistedSecrets(input) {
  const databases = [];
  if (input.memoryDb) {
    databases.push(await auditPersistedSecretDatabase({ path: input.memoryDb, kind: "memory" }));
  }
  if (input.conversationDb) {
    databases.push(await auditPersistedSecretDatabase({ path: input.conversationDb, kind: "conversation" }));
  }
  if (input.lancedbDir) {
    databases.push(await auditPersistedSecretLanceDb({ path: input.lancedbDir }));
  }
  assert.ok(databases.length > 0, "at least one persisted-secret database is required");
  const totals = databases.reduce((current, database) => ({
    secretBearingRows: current.secretBearingRows + database.secretBearingRows,
    secretBearingFields: current.secretBearingFields + database.secretBearingFields,
    uniqueFlaggedPayloadsUpperBound:
      current.uniqueFlaggedPayloadsUpperBound + database.uniqueFlaggedPayloads,
  }), { secretBearingRows: 0, secretBearingFields: 0, uniqueFlaggedPayloadsUpperBound: 0 });
  const blockers = [];
  if (totals.secretBearingRows > 0) blockers.push("persisted_secret_material_detected");
  if (databases.some((database) => database.ownerOnlyMode === false)) {
    blockers.push("database_file_not_owner_only");
  }
  return {
    schemaVersion: 2,
    phase: "clawlore-persisted-secret-audit",
    auditedAt: new Date().toISOString(),
    readOnly: true,
    emitsSecretValues: false,
    emitsMemoryContent: false,
    status: blockers.length === 0 ? "pass" : "fail",
    databases,
    totals,
    blockers,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument: ${token ?? ""}`);
    }
    args[token.slice(2)] = value;
  }
  if (!args["memory-db"] && !args["conversation-db"] && !args["lancedb-dir"]) {
    throw new Error("--memory-db, --conversation-db, or --lancedb-dir is required");
  }
  if (!args.receipt) throw new Error("--receipt is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await auditPersistedSecrets({
    memoryDb: args["memory-db"],
    conversationDb: args["conversation-db"],
    lancedbDir: args["lancedb-dir"],
  });
  const receiptPath = resolve(args.receipt);
  await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    totals: report.totals,
    blockers: report.blockers,
  })}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
