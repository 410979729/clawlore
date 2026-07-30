import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  RELEASE_IMMUTABLE_BINDING_FIELDS_V1,
  validateRuntimeReleaseReadinessV1,
} from "./application/runtime-release-readiness-validation.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import type {
  ReleaseArtifactBindingV1,
  ReleaseReadinessReceiptV1,
} from "./v2/domain/release.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

const AUTHORITY_TABLE = "clawlore_runtime_release_authority";
const DIGEST_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{40}$/i;
const WRITE_MODES = new Set(["v2-write", "cutover"]);

const AUTHORITY_SCHEMA_SQL = `
  CREATE TABLE clawlore_runtime_release_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    mode TEXT NOT NULL CHECK(mode IN ('v2-write','cutover')),
    source_commit TEXT NOT NULL,
    runtime_digest TEXT NOT NULL,
    package_digest TEXT NOT NULL,
    lock_digest TEXT NOT NULL,
    config_digest TEXT NOT NULL,
    test_log_digest TEXT NOT NULL,
    initial_truth_snapshot_digest TEXT NOT NULL,
    readiness_sha256 TEXT NOT NULL,
    readiness_created_at TEXT NOT NULL,
    readiness_expires_at TEXT NOT NULL,
    authorized_at TEXT NOT NULL
  );
`;

const AUTHORITY_COLUMNS = new Map([
  ["singleton", "INTEGER"],
  ["schema_version", "INTEGER"],
  ["mode", "TEXT"],
  ["source_commit", "TEXT"],
  ["runtime_digest", "TEXT"],
  ["package_digest", "TEXT"],
  ["lock_digest", "TEXT"],
  ["config_digest", "TEXT"],
  ["test_log_digest", "TEXT"],
  ["initial_truth_snapshot_digest", "TEXT"],
  ["readiness_sha256", "TEXT"],
  ["readiness_created_at", "TEXT"],
  ["readiness_expires_at", "TEXT"],
  ["authorized_at", "TEXT"],
]);

export type RuntimeReleaseWriteModeV1 = "v2-write" | "cutover";

export interface RuntimeReleaseAuthorityInspectionV1 {
  schemaVersion: 1;
  status: "absent" | "valid" | "mismatch" | "invalid";
  mismatchedFields: string[];
  authorizedAt?: string;
  readinessSha256?: string;
  error?: string;
}

interface AuthorityRow {
  singleton?: number;
  schema_version?: number;
  mode?: string;
  source_commit?: string;
  runtime_digest?: string;
  package_digest?: string;
  lock_digest?: string;
  config_digest?: string;
  test_log_digest?: string;
  initial_truth_snapshot_digest?: string;
  readiness_sha256?: string;
  readiness_created_at?: string;
  readiness_expires_at?: string;
  authorized_at?: string;
}

function tableExists(db: DatabaseSync): boolean {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
  ).get(AUTHORITY_TABLE).n) === 1;
}

function schemaIsValid(db: DatabaseSync): boolean {
  const columns = db.prepare(
    `PRAGMA table_info(${AUTHORITY_TABLE})`,
  ).all() as Array<{ name?: string; type?: string; pk?: number }>;
  if (columns.length !== AUTHORITY_COLUMNS.size) return false;
  for (const column of columns) {
    const expectedType = AUTHORITY_COLUMNS.get(String(column.name));
    if (!expectedType || String(column.type).toUpperCase() !== expectedType) return false;
    if (column.name === "singleton" && Number(column.pk) !== 1) return false;
  }
  return true;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function rowIsValid(row: AuthorityRow | undefined): row is Required<AuthorityRow> {
  return Boolean(
    row
    && Number(row.singleton) === 1
    && Number(row.schema_version) === 1
    && WRITE_MODES.has(String(row.mode))
    && COMMIT_RE.test(String(row.source_commit ?? ""))
    && DIGEST_RE.test(String(row.runtime_digest ?? ""))
    && DIGEST_RE.test(String(row.package_digest ?? ""))
    && DIGEST_RE.test(String(row.lock_digest ?? ""))
    && DIGEST_RE.test(String(row.config_digest ?? ""))
    && DIGEST_RE.test(String(row.test_log_digest ?? ""))
    && DIGEST_RE.test(String(row.initial_truth_snapshot_digest ?? ""))
    && DIGEST_RE.test(String(row.readiness_sha256 ?? ""))
    && isoTimestamp(row.readiness_created_at)
    && isoTimestamp(row.readiness_expires_at)
    && isoTimestamp(row.authorized_at),
  );
}

function inspectDatabase(
  db: DatabaseSync,
  expectedBinding: ReleaseArtifactBindingV1,
  expectedMode: RuntimeReleaseWriteModeV1,
): RuntimeReleaseAuthorityInspectionV1 {
  if (!tableExists(db)) {
    return { schemaVersion: 1, status: "absent", mismatchedFields: [] };
  }
  if (!schemaIsValid(db)) {
    return {
      schemaVersion: 1,
      status: "invalid",
      mismatchedFields: [],
      error: "runtime_release_authority_schema_invalid",
    };
  }
  const rows = db.prepare(
    `SELECT * FROM ${AUTHORITY_TABLE} ORDER BY singleton`,
  ).all() as AuthorityRow[];
  if (rows.length !== 1 || !rowIsValid(rows[0])) {
    return {
      schemaVersion: 1,
      status: "invalid",
      mismatchedFields: [],
      error: "runtime_release_authority_row_invalid",
    };
  }

  const row = rows[0];
  const authorityBinding: Pick<
    ReleaseArtifactBindingV1,
    typeof RELEASE_IMMUTABLE_BINDING_FIELDS_V1[number]
  > = {
    sourceCommit: row.source_commit,
    runtimeDigest: row.runtime_digest,
    packageDigest: row.package_digest,
    lockDigest: row.lock_digest,
    configDigest: row.config_digest,
    testLogDigest: row.test_log_digest,
  };
  const mismatchedFields = [
    ...(row.mode === expectedMode ? [] : ["mode"]),
    ...RELEASE_IMMUTABLE_BINDING_FIELDS_V1.filter(
      (field) => authorityBinding[field] !== expectedBinding[field],
    ),
  ];
  return {
    schemaVersion: 1,
    status: mismatchedFields.length === 0 ? "valid" : "mismatch",
    mismatchedFields,
    authorizedAt: row.authorized_at,
    readinessSha256: row.readiness_sha256,
  };
}

export function runtimeReleaseReadinessDigestV1(
  readiness: ReleaseReadinessReceiptV1,
): string {
  return createHash("sha256").update(JSON.stringify(readiness)).digest("hex");
}

/**
 * Reads the durable release authority without creating or mutating schema.
 */
export function inspectRuntimeReleaseAuthorityV1(input: {
  sqlitePath: string;
  expectedBinding: ReleaseArtifactBindingV1;
  expectedMode: RuntimeReleaseWriteModeV1;
}): RuntimeReleaseAuthorityInspectionV1 {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    return inspectDatabase(db, input.expectedBinding, input.expectedMode);
  } catch (error) {
    return {
      schemaVersion: 1,
      status: "invalid",
      mismatchedFields: [],
      error: `runtime_release_authority_inspection_failed:${diagnosticErrorSummary(error)}`,
    };
  } finally {
    db.close();
  }
}

/**
 * Persists authority only from a currently fresh, exact, ready receipt.
 *
 * Existing malformed authority is never silently repaired. A valid but stale
 * release binding may be replaced only after the new release passes the full
 * receipt gate.
 */
export function recordRuntimeReleaseAuthorityV1(input: {
  sqlitePath: string;
  expectedBinding: ReleaseArtifactBindingV1;
  expectedMode: RuntimeReleaseWriteModeV1;
  readiness: ReleaseReadinessReceiptV1;
  now?: () => Date;
}): RuntimeReleaseAuthorityInspectionV1 {
  const now = input.now?.() ?? new Date();
  const readiness = validateRuntimeReleaseReadinessV1({
    value: input.readiness,
    expectedBinding: input.expectedBinding,
    expectedMode: input.expectedMode,
    verification: "full-receipt",
    now,
  });
  if (
    readiness.status !== "ready"
    || readiness.compatibilityValid !== true
    || readiness.rollout.ready !== true
  ) {
    throw new Error("runtime_release_authority_requires_ready_receipt");
  }

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sqlitePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;");
    try {
      const existed = tableExists(db);
      if (existed) {
        const current = inspectDatabase(db, input.expectedBinding, input.expectedMode);
        if (current.status === "invalid") {
          throw new Error(current.error ?? "runtime_release_authority_invalid");
        }
      } else {
        db.exec(AUTHORITY_SCHEMA_SQL);
      }

      const readinessSha256 = runtimeReleaseReadinessDigestV1(readiness);
      db.prepare(`
        INSERT INTO ${AUTHORITY_TABLE} (
          singleton,schema_version,mode,source_commit,runtime_digest,
          package_digest,lock_digest,config_digest,test_log_digest,
          initial_truth_snapshot_digest,readiness_sha256,
          readiness_created_at,readiness_expires_at,authorized_at
        ) VALUES (1,1,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET
          schema_version=excluded.schema_version,
          mode=excluded.mode,
          source_commit=excluded.source_commit,
          runtime_digest=excluded.runtime_digest,
          package_digest=excluded.package_digest,
          lock_digest=excluded.lock_digest,
          config_digest=excluded.config_digest,
          test_log_digest=excluded.test_log_digest,
          initial_truth_snapshot_digest=excluded.initial_truth_snapshot_digest,
          readiness_sha256=excluded.readiness_sha256,
          readiness_created_at=excluded.readiness_created_at,
          readiness_expires_at=excluded.readiness_expires_at,
          authorized_at=excluded.authorized_at
      `).run(
        input.expectedMode,
        input.expectedBinding.sourceCommit,
        input.expectedBinding.runtimeDigest,
        input.expectedBinding.packageDigest,
        input.expectedBinding.lockDigest,
        input.expectedBinding.configDigest,
        input.expectedBinding.testLogDigest,
        input.expectedBinding.truthSnapshotDigest,
        readinessSha256,
        readiness.provenance.createdAt,
        readiness.provenance.expiresAt,
        now.toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    db.close();
  }

  return inspectRuntimeReleaseAuthorityV1({
    sqlitePath: input.sqlitePath,
    expectedBinding: input.expectedBinding,
    expectedMode: input.expectedMode,
  });
}
