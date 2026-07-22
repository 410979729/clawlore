#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findSecret } from "../dist/src/secret-redaction.js";

const FIELD_MAP = {
  memory: {
    memory_truth: ["text", "metadata", "metadata_text"],
    memory_items: ["content"],
    memory_revisions: ["content"],
    nightly_digest_runs: ["notes"],
    task_episodes: [
      "task_goal", "user_intent", "message_ids", "journal_entry_ids",
      "tool_names", "evidence", "verification", "environment", "metadata",
    ],
    procedural_playbooks: [
      "title", "trigger", "goal", "preconditions", "steps", "pitfalls",
      "verification", "cleanup", "evidence_anchors", "related_skills",
      "environment_constraints", "reuse_policy", "metadata",
    ],
  },
  conversation: {
    conversations: ["summary", "detail", "source_detail", "tools_used", "model_used"],
    extraction_runs: ["notes"],
    decisions: ["decision", "context", "rationale", "alternatives_considered", "impact"],
    research_queries: ["query", "findings", "sources"],
    task_executions: [
      "description", "result_summary", "lessons_learned", "pitfalls_encountered",
      "files_modified", "root_cause", "fix_applied",
    ],
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export async function auditPersistedSecretDatabase({ path, kind }) {
  assert.ok(FIELD_MAP[kind], `unsupported persisted-secret database kind: ${kind}`);
  const canonicalPath = await realpath(resolve(path));
  const info = await stat(canonicalPath);
  assert.equal(info.isFile(), true, `${kind} database must be a regular file`);
  const db = new DatabaseSync(canonicalPath, { readOnly: true });
  const findings = [];
  const flaggedPayloads = new Set();
  let secretBearingRows = 0;
  let secretBearingFields = 0;

  try {
    for (const [table, requestedFields] of Object.entries(FIELD_MAP[kind])) {
      if (!tableExists(db, table)) continue;
      const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
        .map((column) => String(column.name)));
      const fields = requestedFields.filter((field) => columns.has(field));
      if (fields.length === 0) continue;

      const selected = fields.map(quoteIdentifier).join(", ");
      const rows = db.prepare(`SELECT rowid AS __rowid, ${selected} FROM ${quoteIdentifier(table)}`);
      const rowHits = new Set();
      const patternCounts = {};
      let tableFieldHits = 0;
      let scannedRows = 0;

      for (const row of rows.iterate()) {
        scannedRows += 1;
        for (const field of fields) {
          const value = row[field];
          if (value === null || value === undefined || value === "") continue;
          const text = String(value);
          const secret = findSecret(text);
          if (!secret) continue;
          rowHits.add(String(row.__rowid));
          flaggedPayloads.add(sha256(text));
          tableFieldHits += 1;
          patternCounts[secret.name] = (patternCounts[secret.name] ?? 0) + 1;
        }
      }

      if (tableFieldHits > 0) {
        findings.push({
          table,
          scannedRows,
          secretBearingRows: rowHits.size,
          secretBearingFields: tableFieldHits,
          patternCounts,
        });
        secretBearingRows += rowHits.size;
        secretBearingFields += tableFieldHits;
      }
    }
  } finally {
    db.close();
  }

  return {
    kind,
    databasePathSha256: sha256(canonicalPath),
    ownerOnlyMode: process.platform === "win32" ? null : (info.mode & 0o077) === 0,
    secretBearingRows,
    secretBearingFields,
    uniqueFlaggedPayloads: flaggedPayloads.size,
    findings,
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
  if (!args["memory-db"] && !args["conversation-db"]) {
    throw new Error("--memory-db or --conversation-db is required");
  }
  if (!args.receipt) throw new Error("--receipt is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await auditPersistedSecrets({
    memoryDb: args["memory-db"],
    conversationDb: args["conversation-db"],
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
