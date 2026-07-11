import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface LegacyMigrationPreviewV2 {
  schemaVersion: 2;
  readOnly: true;
  totalRows: number;
  classifications: Record<string, number>;
  verificationDebt: number;
  invalidMetadataRows: number;
}

function classify(metadata: Record<string, unknown>): string {
  const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
  if (source.includes("manual") || source.includes("user")) return "explicit_manual";
  if (source.includes("reflection") || source.includes("summary")) return "reflection_summary";
  if (source.includes("experience") || source.includes("episode") || source.includes("playbook")) return "task_experience";
  if (source.includes("capture") || source.includes("extract")) return "auto_capture";
  return "unknown_legacy";
}

export function previewLegacyMigrationV2(sqlitePath: string): LegacyMigrationPreviewV2 {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => any;
  };
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_truth'").get();
    if (!exists) return { schemaVersion: 2, readOnly: true, totalRows: 0, classifications: {}, verificationDebt: 0, invalidMetadataRows: 0 };
    const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all() as Array<{ metadata?: string }>;
    const classifications: Record<string, number> = {};
    let verificationDebt = 0;
    let invalidMetadataRows = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata || "{}"); } catch { invalidMetadataRows += 1; }
      const kind = classify(metadata);
      classifications[kind] = (classifications[kind] ?? 0) + 1;
      const verification = String(metadata.verification ?? metadata.verification_status ?? "");
      if (!verification || kind === "unknown_legacy") verificationDebt += 1;
    }
    return { schemaVersion: 2, readOnly: true, totalRows: rows.length, classifications, verificationDebt, invalidMetadataRows };
  } finally {
    db.close();
  }
}
