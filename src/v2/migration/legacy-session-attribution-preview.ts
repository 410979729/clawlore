import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface LegacySessionAttributionPreviewV2 {
  schemaVersion: 1;
  readOnly: true;
  totalRows: number;
  lanes: {
    trustedPrivatePrincipal: number;
    trustedConversationBoundary: number;
    trustedOtherSession: number;
    unresolvedSessionReference: number;
    noSessionReference: number;
  };
  trustedCoverageRows: number;
  trustedCoverageRatio: number;
  transcriptContentRead: false;
}

function metadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sessionReference(meta: Record<string, unknown>): string | undefined {
  for (const key of ["sessionKey", "session_key", "source_session", "sessionId", "session_id"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function loadRegistryKeys(path: string): Set<string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return new Set(Object.keys(parsed));
}

function isDirectSessionKey(value: string): boolean {
  return /^agent:[^:]+:[^:]+:[^:]+:direct:[^:]+$/.test(value);
}

function isConversationSessionKey(value: string): boolean {
  return /^agent:[^:]+:[^:]+:group:[^:]+(?::topic:[^:]+)?$/.test(value);
}

export function previewLegacySessionAttributionV2(input: {
  legacyPath: string;
  sessionsRegistryPath: string;
}): LegacySessionAttributionPreviewV2 {
  const registryKeys = loadRegistryKeys(input.sessionsRegistryPath);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.legacyPath, { readOnly: true });
  const lanes = {
    trustedPrivatePrincipal: 0,
    trustedConversationBoundary: 0,
    trustedOtherSession: 0,
    unresolvedSessionReference: 0,
    noSessionReference: 0,
  };
  try {
    const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all() as Array<{ metadata: string }>;
    for (const row of rows) {
      const ref = sessionReference(metadata(row.metadata));
      if (!ref) {
        lanes.noSessionReference += 1;
      } else if (!registryKeys.has(ref)) {
        lanes.unresolvedSessionReference += 1;
      } else if (isDirectSessionKey(ref)) {
        lanes.trustedPrivatePrincipal += 1;
      } else if (isConversationSessionKey(ref)) {
        lanes.trustedConversationBoundary += 1;
      } else {
        lanes.trustedOtherSession += 1;
      }
    }
    const trustedCoverageRows = lanes.trustedPrivatePrincipal
      + lanes.trustedConversationBoundary
      + lanes.trustedOtherSession;
    return {
      schemaVersion: 1,
      readOnly: true,
      totalRows: rows.length,
      lanes,
      trustedCoverageRows,
      trustedCoverageRatio: rows.length ? trustedCoverageRows / rows.length : 0,
      transcriptContentRead: false,
    };
  } finally {
    db.close();
  }
}
