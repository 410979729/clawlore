import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface LegacyManualReviewPreviewV2 {
  schemaVersion: 1;
  readOnly: true;
  contentRead: false;
  manualRows: number;
  lanes: {
    metadataPrincipalEvidence: number;
    preserveArchived: number;
    operatorIdentityAssignment: number;
    scopeReview: number;
    invalidMetadata: number;
  };
  automaticActivationRows: 0;
}

function isManualSource(metadata: Record<string, unknown>): boolean {
  const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
  return source.includes("manual") || source.includes("user");
}

function hasPrincipalEvidence(metadata: Record<string, unknown>): boolean {
  return ["principalId", "principal_id", "senderId", "sender_id", "userId", "user_id"]
    .some((key) => metadata[key] !== undefined && metadata[key] !== null && String(metadata[key]).trim());
}

export function previewLegacyManualReviewV2(sqlitePath: string): LegacyManualReviewPreviewV2 {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const lanes = {
    metadataPrincipalEvidence: 0,
    preserveArchived: 0,
    operatorIdentityAssignment: 0,
    scopeReview: 0,
    invalidMetadata: 0,
  };
  let manualRows = 0;
  try {
    const rows = db.prepare("SELECT scope, metadata FROM memory_truth ORDER BY id")
      .all() as Array<{ scope: string; metadata: string }>;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.metadata || "{}");
        metadata = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        continue;
      }
      if (!isManualSource(metadata)) continue;
      manualRows += 1;
      const state = String(metadata.state ?? metadata.lifecycle ?? "").toLowerCase();
      if (["archived", "rejected", "superseded", "forgotten"].includes(state)) {
        lanes.preserveArchived += 1;
      } else if (hasPrincipalEvidence(metadata)) {
        lanes.metadataPrincipalEvidence += 1;
      } else if (/^agent:[^:]+$/.test(row.scope)) {
        lanes.operatorIdentityAssignment += 1;
      } else {
        lanes.scopeReview += 1;
      }
    }
    return {
      schemaVersion: 1,
      readOnly: true,
      contentRead: false,
      manualRows,
      lanes,
      automaticActivationRows: 0,
    };
  } finally {
    db.close();
  }
}
