import { createHash } from "node:crypto";
import { findSecret } from "./secret-redaction.js";
import {
  PERSISTED_SECRET_FIELD_MAP,
  type PersistedSecretDatabaseKind,
} from "./persisted-secret-policy.js";

type DatabaseSync = any;

export interface PersistedSecretFieldHit {
  table: string;
  field: string;
  rowid: number;
  pattern: string;
  payloadSha256: string;
  value: string;
  row: Record<string, unknown>;
}

export interface PersistedSecretScanSummary {
  secretBearingRows: number;
  secretBearingFields: number;
  uniqueFlaggedPayloads: number;
  findings: Array<{
    table: string;
    scannedRows: number;
    secretBearingRows: number;
    secretBearingFields: number;
    patternCounts: Record<string, number>;
  }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function scanPersistedSecretDatabase(
  db: DatabaseSync,
  kind: PersistedSecretDatabaseKind,
): { hits: PersistedSecretFieldHit[]; summary: PersistedSecretScanSummary } {
  const hits: PersistedSecretFieldHit[] = [];
  const findings: PersistedSecretScanSummary["findings"] = [];
  const flaggedPayloads = new Set<string>();
  let secretBearingRows = 0;
  let secretBearingFields = 0;

  for (const [table, requestedFields] of Object.entries(PERSISTED_SECRET_FIELD_MAP[kind])) {
    if (!tableExists(db, table)) continue;
    const columns = new Set((db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: unknown }>)
      .map((column) => String(column.name)));
    const fields = requestedFields.filter((field: string) => columns.has(field));
    if (fields.length === 0) continue;
    const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${quoteIdentifier(table)}`);
    const rowHits = new Set<string>();
    const patternCounts: Record<string, number> = {};
    let tableFieldHits = 0;
    let scannedRows = 0;
    for (const row of rows.iterate() as Iterable<Record<string, unknown>>) {
      scannedRows += 1;
      for (const field of fields) {
        const raw = row[field];
        if (raw === null || raw === undefined || raw === "") continue;
        const value = String(raw);
        const secret = findSecret(value);
        if (!secret) continue;
        const rowid = Number(row.__rowid);
        hits.push({ table, field, rowid, pattern: secret.name, payloadSha256: sha256(value), value, row });
        rowHits.add(String(rowid));
        flaggedPayloads.add(sha256(value));
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
  return {
    hits,
    summary: {
      secretBearingRows,
      secretBearingFields,
      uniqueFlaggedPayloads: flaggedPayloads.size,
      findings,
    },
  };
}

export { quoteIdentifier };
