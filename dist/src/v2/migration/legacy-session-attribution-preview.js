import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function metadata(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function sessionReferences(meta) {
    const references = [];
    for (const key of ["sessionKey", "session_key", "source_session", "sessionId", "session_id"]) {
        const value = meta[key];
        if (typeof value === "string" && value.trim())
            references.push({ field: key, value: value.trim() });
    }
    return references;
}
function addUnique(index, value, key) {
    const current = index.get(value);
    if (current === undefined)
        index.set(value, key);
    else if (current !== key)
        index.set(value, null);
}
function sessionFileIdentity(value) {
    const name = value.replace(/\\/g, "/").split("/").at(-1) ?? value;
    return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}
function loadRegistry(path) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const keys = new Set(Object.keys(parsed));
    const sessionIds = new Map();
    const sessionFiles = new Map();
    for (const [key, rawEntry] of Object.entries(parsed)) {
        if (!rawEntry || typeof rawEntry !== "object")
            continue;
        const entry = rawEntry;
        if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
            addUnique(sessionIds, entry.sessionId.trim(), key);
        }
        if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
            addUnique(sessionFiles, sessionFileIdentity(entry.sessionFile.trim()), key);
        }
    }
    return { keys, sessionIds, sessionFiles };
}
function resolveRegistryReference(registry, reference) {
    if (registry.keys.has(reference.value))
        return { key: reference.value, evidence: "registryKey" };
    const byId = registry.sessionIds.get(reference.value);
    if (byId)
        return { key: byId, evidence: "registrySessionId" };
    const byFile = registry.sessionFiles.get(sessionFileIdentity(reference.value));
    if (byFile)
        return { key: byFile, evidence: "registrySessionFile" };
    return undefined;
}
function isDirectSessionKey(value) {
    return /^agent:[^:]+:[^:]+:[^:]+:direct:[^:]+$/.test(value);
}
function isConversationSessionKey(value) {
    return /^agent:[^:]+:[^:]+:group:[^:]+(?::topic:[^:]+)?$/.test(value);
}
function isLegacyAgentScopeAlias(value) {
    const parts = value.split(":");
    return parts.length === 3 && parts[0] === "agent" && parts[1] === parts[2];
}
function isDerivedSystemReference(meta) {
    const source = String(meta.source ?? meta.source_type ?? "").toLowerCase();
    return ["summary", "digest", "reflection", "checkpoint", "pressure-guard", "pressure_guard"]
        .some((kind) => source.includes(kind));
}
export function previewLegacySessionAttributionV2(input) {
    const registry = loadRegistry(input.sessionsRegistryPath);
    const { DatabaseSync } = require("node:sqlite");
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
        const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all();
        for (const row of rows) {
            const meta = metadata(row.metadata);
            const references = sessionReferences(meta);
            if (references.length === 0) {
                lanes.noSessionReference += 1;
                continue;
            }
            const matches = references
                .map((reference) => resolveRegistryReference(registry, reference))
                .filter((match) => Boolean(match));
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
                if (isDirectSessionKey(ref))
                    lanes.trustedPrivatePrincipal += 1;
                else if (isConversationSessionKey(ref))
                    lanes.trustedConversationBoundary += 1;
                else
                    lanes.trustedOtherSession += 1;
                continue;
            }
            const ref = references[0].value;
            if (isLegacyAgentScopeAlias(ref)) {
                lanes.legacyAgentScopeAlias += 1;
            }
            else if (isDerivedSystemReference(meta)) {
                lanes.derivedSystemReference += 1;
            }
            else if (ref.startsWith("agent:")) {
                lanes.unresolvedSessionReference += 1;
            }
            else {
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
    }
    finally {
        db.close();
    }
}
