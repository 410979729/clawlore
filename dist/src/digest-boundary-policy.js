import { createHash } from "node:crypto";
import { sanitizeCaptureText } from "./capture-safety.js";
import { redactMemoryTextForOutput } from "./memory-egress-policy.js";
import { normalizeTruthIdentifier } from "./v2/domain/truth-write-policy.js";
const SOURCE_TYPES = new Set([
    "explicit",
    "reflection_event",
    "memory_truth",
    "openclaw_sqlite_transcript",
]);
const ABSOLUTE_PATH = /(?:^|\s)(?:~[\\/]|\/[A-Za-z0-9_.-]+\/|[A-Za-z]:[\\/])/u;
const DURABLE_IDENTIFIER = /^[\p{L}\p{N}._:@/-]+$/u;
function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}
/**
 * Provenance identifiers remain human-readable when they are ordinary IDs.
 * Paths or unsafe legacy values become deterministic digests so correlation is
 * retained without persisting workstation paths or credential-shaped values.
 */
export function digestSourceIdentifier(value, prefix = "source") {
    const raw = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
    if (!raw)
        return `${prefix}-unknown`;
    try {
        const normalized = normalizeTruthIdentifier(raw, "digest source identifier", 512);
        if (ABSOLUTE_PATH.test(normalized))
            throw new Error("absolute path provenance is not durable");
        return normalized;
    }
    catch {
        return `${prefix}-sha256-${digest(raw)}`;
    }
}
export function requireDigestBoundaryIdentifier(value, label, fallback) {
    const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
    const normalized = normalizeTruthIdentifier(raw, label, 512);
    if (normalized !== raw || !DURABLE_IDENTIFIER.test(normalized) || ABSOLUTE_PATH.test(normalized)) {
        throw new Error(`${label} rejected by safety policy`);
    }
    return normalized;
}
export function requireDigestSourceType(value, fallback) {
    const sourceType = value ?? fallback;
    if (typeof sourceType !== "string" || !SOURCE_TYPES.has(sourceType)) {
        throw new Error("digest source type is unsupported");
    }
    return sourceType;
}
export function normalizeDigestInputChunks(inputChunks, scope, maxChunks) {
    if (inputChunks.length > maxChunks)
        throw new Error("digest inputChunks exceed maxChunks");
    const normalized = inputChunks.map((chunk) => {
        const chunkScope = requireDigestBoundaryIdentifier(chunk.scope, "digest chunk scope", "");
        if (chunkScope !== scope)
            throw new Error("digest chunk scope does not match the target scope");
        if (typeof chunk.text !== "string" || !chunk.text.trim()) {
            throw new Error("digest chunk text is required");
        }
        return {
            id: digestSourceIdentifier(chunk.id, "chunk"),
            source_type: requireDigestSourceType(chunk.source_type, "openclaw_sqlite_transcript"),
            source_id: digestSourceIdentifier(chunk.source_id, "source"),
            scope: chunkScope,
            text: chunk.text,
        };
    });
    if (new Set(normalized.map((chunk) => chunk.source_type)).size > 1) {
        throw new Error("digest inputChunks must use one source type");
    }
    return normalized;
}
export function digestLedgerRowForOutput(row) {
    const result = { ...row };
    if ("source_id" in result)
        result.source_id = digestSourceIdentifier(result.source_id, "legacy-source");
    if ("scope" in result)
        result.scope = digestSourceIdentifier(result.scope, "legacy-scope");
    if ("actor" in result)
        result.actor = digestSourceIdentifier(result.actor, "legacy-actor");
    for (const field of ["reason", "preview", "notes", "candidate_ids"]) {
        if (field in result && typeof result[field] === "string") {
            result[field] = redactMemoryTextForOutput(result[field]);
        }
    }
    return result;
}
export function digestPreviewFor(value) {
    return sanitizeCaptureText(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\/home\/[^\s"',;)}\]]+/g, "[redacted:path]")
        .replace(/\/Users\/[^\s"',;)}\]]+/g, "[redacted:path]")
        .replace(/[A-Z]:\\[^\s"',;)}\]]+/g, "[redacted:path]")
        .slice(0, 220);
}
export function digestSafeJson(value) {
    return JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            return item;
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    });
}
export function parseDigestJsonObject(raw) {
    if (!raw)
        return {};
    if (typeof raw === "object" && !Array.isArray(raw))
        return raw;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
