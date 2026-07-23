#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import {
  buildPersistedSecretRemediationPlan,
  executePersistedSecretRemediation,
} from "../dist/src/v2/operator/persisted-secret-remediation.js";
import {
  DEFAULT_LANCE_SCAN_MAX_ROWS,
  scanLanceRows,
} from "../dist/src/lance-row-scan.js";
import { withMemoryWriteLock } from "../dist/src/memory-write-lock.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsInside(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

class LanceVectorPort {
  constructor(path) {
    this.path = path;
    this.db = null;
    this.table = null;
  }

  async open() {
    this.db ??= await lancedb.connect(this.path);
    this.table ??= await this.db.openTable("memories");
    return this.table;
  }

  async scanRows(consume) {
    const table = await this.open();
    return scanLanceRows(
      () => table.query().select(["id", "text", "metadata"]),
      (rows) => consume(rows.map((row) => ({
        id: String(row.id),
        text: String(row.text ?? ""),
        metadata: String(row.metadata ?? ""),
      }))),
      { maxRows: DEFAULT_LANCE_SCAN_MAX_ROWS },
    );
  }

  async existingIds(ids) {
    if (ids.length === 0) return [];
    const table = await this.open();
    const existing = new Set();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const batch = ids.slice(offset, offset + 256);
      const scan = await scanLanceRows(
        () => table.query()
          .where(`id IN (${batch.map((id) => `'${escapeSql(id)}'`).join(",")})`)
          .select(["id"]),
        (rows) => {
          for (const row of rows) existing.add(String(row.id));
        },
        { maxRows: batch.length },
      );
      if (scan.truncated) throw new Error("vector identity query exceeded its bounded input");
    }
    return [...existing].sort();
  }

  async deleteIds(ids) {
    if (ids.length === 0) return 0;
    const table = await this.open();
    const existing = await this.existingIds(ids);
    if (existing.length !== ids.length) throw new Error("planned vector item disappeared before apply");
    for (let offset = 0; offset < ids.length; offset += 256) {
      const batch = ids.slice(offset, offset + 256);
      await table.delete(`id IN (${batch.map((id) => `'${escapeSql(id)}'`).join(",")})`);
    }
    const remaining = new Set(await this.existingIds(ids));
    return ids.filter((id) => !remaining.has(id)).length;
  }

  async close() {
    await this.table?.close?.();
    await this.db?.close?.();
  }
}

function parseArgs(argv) {
  const args = {};
  const artifactRoots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "artifact-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      artifactRoots.push(value);
      index += 1;
      continue;
    }
    if (["apply", "approved", "credentials-rotated", "tighten-permissions"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[key] = value;
    index += 1;
  }
  for (const required of ["memory-db", "conversation-db", "lancedb-dir", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (artifactRoots.length === 0) throw new Error("--artifact-root is required");
  args["artifact-roots"] = artifactRoots;
  return args;
}

async function verifySnapshotReceipt(path, sourcePath) {
  const canonical = await realpath(resolve(path));
  const info = await stat(canonical);
  assert.equal(info.isFile(), true, "snapshot receipt must be a regular file");
  if (process.platform !== "win32") assert.equal((info.mode & 0o077) === 0, true,
    "snapshot receipt must be owner-only");
  const receipt = JSON.parse(await readFile(canonical, "utf8"));
  assert.equal(receipt.status, "pass", "snapshot receipt status must pass");
  assert.equal(receipt.restoreVerified, true, "snapshot receipt must prove restore verification");
  const expectedSourceRef = sha256(resolve(sourcePath));
  assert.ok(receipt.sourceRef === expectedSourceRef || receipt.sourceRef === expectedSourceRef.slice(0, 20),
    "snapshot receipt source does not match remediation database");
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = {
    memoryDbPath: resolve(args["memory-db"]),
    conversationDbPath: resolve(args["conversation-db"]),
    vectorPath: resolve(args["lancedb-dir"]),
    artifactRoots: args["artifact-roots"].map((path) => resolve(path)),
  };
  const receiptPath = resolve(args.receipt);
  if (
    [paths.memoryDbPath, paths.conversationDbPath].includes(receiptPath)
    || [paths.vectorPath, ...paths.artifactRoots]
      .some((root) => pathIsInside(root, receiptPath))
  ) {
    throw new Error("receipt must be outside every remediated persisted-secret surface");
  }
  const vector = new LanceVectorPort(paths.vectorPath);
  try {
    const receipt = await withMemoryWriteLock(paths.vectorPath, async () => {
      if (args.apply === true) {
        for (const required of [
          "expected-plan-digest",
          "memory-snapshot-receipt",
          "conversation-snapshot-receipt",
          "vector-snapshot-receipt",
        ]) {
          if (!args[required]) throw new Error(`--${required} is required with --apply`);
        }
        const snapshotsVerified = await verifySnapshotReceipt(
          args["memory-snapshot-receipt"],
          paths.memoryDbPath,
        ) && await verifySnapshotReceipt(
          args["conversation-snapshot-receipt"],
          paths.conversationDbPath,
        );
        const vectorSnapshotVerified = await verifySnapshotReceipt(
          args["vector-snapshot-receipt"],
          paths.vectorPath,
        );
        return executePersistedSecretRemediation({
          ...paths,
          vector,
          expectedPlanDigest: args["expected-plan-digest"],
          approved: args.approved === true,
          snapshotsVerified,
          vectorSnapshotVerified,
          credentialsRotated: args["credentials-rotated"] === true,
          tightenPermissions: args["tighten-permissions"] === true,
        });
      }
      return (await buildPersistedSecretRemediationPlan({ ...paths, vector })).receipt;
    });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(receiptPath, 0o600);
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      planDigest: receipt.planDigest,
      targets: receipt.targets ?? receipt.applied,
    })}\n`);
  } finally {
    await vector.close();
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
