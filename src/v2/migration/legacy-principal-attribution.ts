import { createHash } from "node:crypto";
import { resolveRuntimeMemoryBoundary } from "../../runtime-memory-boundary.js";

export const LEGACY_STRONG_SESSION_FIELDS_V1 = [
  "sessionKey",
  "session_key",
  "source_session",
] as const;

const OPAQUE_SESSION_FIELDS = [
  "sessionId",
  "session_id",
  "sessionFile",
  "session_file",
] as const;

export type LegacyPrincipalAttributionLaneV1 =
  | "target_private_source_scope"
  | "target_private_already_assigned"
  | "target_private_unexpected_scope"
  | "other_private_session"
  | "conversation_session"
  | "conflicting_session_reference"
  | "malformed_session_reference"
  | "derived_system_reference"
  | "manual_unattributed"
  | "opaque_session_reference"
  | "no_identity_reference"
  | "invalid_metadata";

export interface LegacyPrincipalAttributionV1 {
  lane: LegacyPrincipalAttributionLaneV1;
  evidenceFields: string[];
  referenceDigest?: string;
  targetEvidence: boolean;
  migrationEligible: boolean;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseMetadata(value: string | Record<string, unknown>): {
  valid: boolean;
  value: Record<string, unknown>;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { valid: true, value };
  }
  if (typeof value !== "string") return { valid: false, value: {} };
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, value: {} };
    }
    return { valid: true, value: parsed as Record<string, unknown> };
  } catch {
    return { valid: false, value: {} };
  }
}

function sourceKind(metadata: Record<string, unknown>): string {
  return String(metadata.source ?? metadata.source_type ?? metadata.type ?? "")
    .trim()
    .toLowerCase();
}

function isDerivedSystemReference(metadata: Record<string, unknown>): boolean {
  const source = sourceKind(metadata);
  return [
    "summary",
    "digest",
    "reflection",
    "checkpoint",
    "pressure-guard",
    "pressure_guard",
    "auto-capture",
    "auto_capture",
  ].some((kind) => source.includes(kind));
}

function isManualReference(metadata: Record<string, unknown>): boolean {
  const source = sourceKind(metadata);
  return source.includes("manual") || source.includes("user");
}

function opaqueSessionFields(metadata: Record<string, unknown>): string[] {
  return OPAQUE_SESSION_FIELDS.filter((field) => {
    const value = metadata[field];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Classify legacy provenance without reading transcript or memory content.
 * Only exact OpenClaw session-key fields are strong enough to move ownership;
 * UUID/file references remain opaque unless a separate registry receipt binds
 * them to a canonical session.
 */
export function classifyLegacyPrincipalAttributionV1(input: {
  metadata: string | Record<string, unknown>;
  currentScope: string;
  sourceScope: string;
  targetScope: string;
  targetSessionKey: string;
}): LegacyPrincipalAttributionV1 {
  const parsed = parseMetadata(input.metadata);
  if (!parsed.valid) {
    return {
      lane: "invalid_metadata",
      evidenceFields: [],
      targetEvidence: false,
      migrationEligible: false,
    };
  }

  const references: Array<{ field: string; value: string }> = [];
  let malformed = false;
  for (const field of LEGACY_STRONG_SESSION_FIELDS_V1) {
    const raw = parsed.value[field];
    if (raw == null || raw === "") continue;
    if (typeof raw !== "string" || !raw.trim() || raw !== raw.trim()) {
      malformed = true;
      continue;
    }
    references.push({ field, value: raw });
  }
  if (malformed) {
    return {
      lane: "malformed_session_reference",
      evidenceFields: references.map((reference) => reference.field).sort(),
      targetEvidence: false,
      migrationEligible: false,
    };
  }

  const uniqueReferences = [...new Set(references.map((reference) => reference.value))];
  if (uniqueReferences.length > 1) {
    return {
      lane: "conflicting_session_reference",
      evidenceFields: references.map((reference) => reference.field).sort(),
      referenceDigest: hash(JSON.stringify(uniqueReferences.sort())),
      targetEvidence: false,
      migrationEligible: false,
    };
  }

  if (uniqueReferences.length === 1) {
    const reference = uniqueReferences[0];
    const evidenceFields = references.map((item) => item.field).sort();
    const referenceDigest = hash(reference);
    if (reference === input.targetSessionKey) {
      if (input.currentScope === input.sourceScope) {
        return {
          lane: "target_private_source_scope",
          evidenceFields,
          referenceDigest,
          targetEvidence: true,
          migrationEligible: true,
        };
      }
      if (input.currentScope === input.targetScope) {
        return {
          lane: "target_private_already_assigned",
          evidenceFields,
          referenceDigest,
          targetEvidence: true,
          migrationEligible: false,
        };
      }
      return {
        lane: "target_private_unexpected_scope",
        evidenceFields,
        referenceDigest,
        targetEvidence: true,
        migrationEligible: false,
      };
    }
    const boundary = resolveRuntimeMemoryBoundary({ runtimeContext: { sessionKey: reference } });
    return {
      lane: boundary.kind === "private"
        ? "other_private_session"
        : boundary.kind === "conversation"
          ? "conversation_session"
          : "opaque_session_reference",
      evidenceFields,
      referenceDigest,
      targetEvidence: false,
      migrationEligible: false,
    };
  }

  if (isDerivedSystemReference(parsed.value)) {
    return {
      lane: "derived_system_reference",
      evidenceFields: [],
      targetEvidence: false,
      migrationEligible: false,
    };
  }
  if (isManualReference(parsed.value)) {
    return {
      lane: "manual_unattributed",
      evidenceFields: [],
      targetEvidence: false,
      migrationEligible: false,
    };
  }
  const opaqueFields = opaqueSessionFields(parsed.value);
  if (opaqueFields.length > 0) {
    return {
      lane: "opaque_session_reference",
      evidenceFields: opaqueFields.sort(),
      targetEvidence: false,
      migrationEligible: false,
    };
  }
  return {
    lane: "no_identity_reference",
    evidenceFields: [],
    targetEvidence: false,
    migrationEligible: false,
  };
}
