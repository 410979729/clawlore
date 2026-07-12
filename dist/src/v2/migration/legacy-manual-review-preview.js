import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function isManualSource(metadata) {
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    return source.includes("manual") || source.includes("user");
}
function hasPrincipalEvidence(metadata) {
    return ["principalId", "principal_id", "senderId", "sender_id", "userId", "user_id"]
        .some((key) => metadata[key] !== undefined && metadata[key] !== null && String(metadata[key]).trim());
}
export function previewLegacyManualReviewV2(sqlitePath) {
    const { DatabaseSync } = require("node:sqlite");
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
            .all();
        for (const row of rows) {
            let metadata;
            try {
                const parsed = JSON.parse(row.metadata || "{}");
                metadata = parsed && typeof parsed === "object" ? parsed : {};
            }
            catch {
                continue;
            }
            if (!isManualSource(metadata))
                continue;
            manualRows += 1;
            const state = String(metadata.state ?? metadata.lifecycle ?? "").toLowerCase();
            if (["archived", "rejected", "superseded", "forgotten"].includes(state)) {
                lanes.preserveArchived += 1;
            }
            else if (hasPrincipalEvidence(metadata)) {
                lanes.metadataPrincipalEvidence += 1;
            }
            else if (/^agent:[^:]+$/.test(row.scope)) {
                lanes.operatorIdentityAssignment += 1;
            }
            else {
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
    }
    finally {
        db.close();
    }
}
