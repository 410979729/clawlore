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
function sessionReference(meta) {
    for (const key of ["sessionKey", "session_key", "source_session", "sessionId", "session_id"]) {
        const value = meta[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function loadRegistryKeys(path) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Object.keys(parsed));
}
function isDirectSessionKey(value) {
    return /^agent:[^:]+:[^:]+:[^:]+:direct:[^:]+$/.test(value);
}
function isConversationSessionKey(value) {
    return /^agent:[^:]+:[^:]+:group:[^:]+(?::topic:[^:]+)?$/.test(value);
}
export function previewLegacySessionAttributionV2(input) {
    const registryKeys = loadRegistryKeys(input.sessionsRegistryPath);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.legacyPath, { readOnly: true });
    const lanes = {
        trustedPrivatePrincipal: 0,
        trustedConversationBoundary: 0,
        trustedOtherSession: 0,
        unresolvedSessionReference: 0,
        noSessionReference: 0,
    };
    try {
        const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all();
        for (const row of rows) {
            const ref = sessionReference(metadata(row.metadata));
            if (!ref) {
                lanes.noSessionReference += 1;
            }
            else if (!registryKeys.has(ref)) {
                lanes.unresolvedSessionReference += 1;
            }
            else if (isDirectSessionKey(ref)) {
                lanes.trustedPrivatePrincipal += 1;
            }
            else if (isConversationSessionKey(ref)) {
                lanes.trustedConversationBoundary += 1;
            }
            else {
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
    }
    finally {
        db.close();
    }
}
