import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface LegacySessionAttributionPreviewV2 {
  schemaVersion: 2;
  readOnly: true;
  totalRows: number;
  lanes: {
    trustedPrivatePrincipal: number;
    trustedConversationBoundary: number;
    trustedOtherSession: number;
    conflictingRegistryEvidence: number;
    unresolvedSessionReference: number;
    legacyAgentScopeAlias: number;
    derivedSystemReference: number;
    opaqueUnverifiableReference: number;
    noSessionReference: number;
  };
  trustedEvidence: {
    registryKey: number;
    registrySessionId: number;
    registrySessionFile: number;
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

interface SessionReference {
  field: string;
  value: string;
}

function sessionReferences(meta: Record<string, unknown>): SessionReference[] {
  const references: SessionReference[] = [];
  for (const key of ["sessionKey", "session_key", "source_session", "sessionId", "session_id"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) references.push({ field: key, value: value.trim() });
  }
  return references;
}

type EvidenceKind = "registryKey" | "registrySessionId" | "registrySessionFile";

interface RegistryIndex {
  keys: Set<string>;
  sessionIds: Map<string, string | null>;
  sessionFiles: Map<string, string | null>;
}

function addUnique(index: Map<string, string | null>, value: string, key: string): void {
  const current = index.get(value);
  if (current === undefined) index.set(value, key);
  else if (current !== key) index.set(value, null);
}

function sessionFileIdentity(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").at(-1) ?? value;
  return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

function loadRegistry(path: string): RegistryIndex {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const keys = new Set(Object.keys(parsed));
  const sessionIds = new Map<string, string | null>();
  const sessionFiles = new Map<string, string | null>();
  for (const [key, rawEntry] of Object.entries(parsed)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      addUnique(sessionIds, entry.sessionId.trim(), key);
    }
    if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
      addUnique(sessionFiles, sessionFileIdentity(entry.sessionFile.trim()), key);
    }
  }
  return { keys, sessionIds, sessionFiles };
}

function resolveRegistryReference(
  registry: RegistryIndex,
  reference: SessionReference,
): { key: string; evidence: EvidenceKind } | undefined {
  if (registry.keys.has(reference.value)) return { key: reference.value, evidence: "registryKey" };
  const byId = registry.sessionIds.get(reference.value);
  if (byId) return { key: byId, evidence: "registrySessionId" };
  const byFile = registry.sessionFiles.get(sessionFileIdentity(reference.value));
  if (byFile) return { key: byFile, evidence: "registrySessionFile" };
  return undefined;
}

function isDirectSessionKey(value: string): boolean {
  return /^agent:[^:]+:[^:]+:[^:]+:direct:[^:]+$/.test(value);
}

function isConversationSessionKey(value: string): boolean {
  return /^agent:[^:]+:[^:]+:group:[^:]+(?::topic:[^:]+)?$/.test(value);
}

function isLegacyAgentScopeAlias(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts[0] === "agent" && parts[1] === parts[2];
}

function isDerivedSystemReference(meta: Record<string, unknown>): boolean {
  const source = String(meta.source ?? meta.source_type ?? "").toLowerCase();
  return ["summary", "digest", "reflection", "checkpoint", "pressure-guard", "pressure_guard"]
    .some((kind) => source.includes(kind));
}

export function previewLegacySessionAttributionV2(input: {
  legacyPath: string;
  sessionsRegistryPath: string;
}): LegacySessionAttributionPreviewV2 {
  const registry = loadRegistry(input.sessionsRegistryPath);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.legacyPath, { readOnly: true });
  const lanes = {
    trustedPrivatePrincipal: 0,
    trustedConversationBoundary: 0,
    trustedOtherSession: 0,
    conflictingRegistryEvidence: 0,
    unresolvedSessionReference: 0,
    legacyAgentScopeAlias: 0,
    derivedSystemReference: 0,
    opaqueUnverifiableReference: 0,
    noSessionReference: 0,
  };
  const trustedEvidence = {
    registryKey: 0,
    registrySessionId: 0,
    registrySessionFile: 0,
  };
  try {
    const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all() as Array<{ metadata: string }>;
    for (const row of rows) {
      const meta = metadata(row.metadata);
      const references = sessionReferences(meta);
      if (references.length === 0) {
        lanes.noSessionReference += 1;
        continue;
      }
      const matches = references
        .map((reference) => resolveRegistryReference(registry, reference))
        .filter((match): match is { key: string; evidence: EvidenceKind } => Boolean(match));
      const matchedKeys = new Set(matches.map((match) => match.key));
      if (matchedKeys.size > 1) {
        lanes.conflictingRegistryEvidence += 1;
        continue;
      }
      if (matchedKeys.size === 1) {
        const ref = [...matchedKeys][0];
        const evidence = matches.find((match) => match.evidence === "registryKey")?.evidence
          ?? matches.find((match) => match.evidence === "registrySessionId")?.evidence
          ?? "registrySessionFile";
        trustedEvidence[evidence] += 1;
        if (isDirectSessionKey(ref)) lanes.trustedPrivatePrincipal += 1;
        else if (isConversationSessionKey(ref)) lanes.trustedConversationBoundary += 1;
        else lanes.trustedOtherSession += 1;
        continue;
      }
      const ref = references[0].value;
      if (isLegacyAgentScopeAlias(ref)) {
        lanes.legacyAgentScopeAlias += 1;
      } else if (isDerivedSystemReference(meta)) {
        lanes.derivedSystemReference += 1;
      } else if (ref.startsWith("agent:")) {
        lanes.unresolvedSessionReference += 1;
      } else {
        lanes.opaqueUnverifiableReference += 1;
      }
    }
    const trustedCoverageRows = lanes.trustedPrivatePrincipal
      + lanes.trustedConversationBoundary
      + lanes.trustedOtherSession;
    return {
      schemaVersion: 2,
      readOnly: true,
      totalRows: rows.length,
      lanes,
      trustedEvidence,
      trustedCoverageRows,
      trustedCoverageRatio: rows.length ? trustedCoverageRows / rows.length : 0,
      transcriptContentRead: false,
    };
  } finally {
    db.close();
  }
}
