import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function classifyLegacySourceV2(metadata) {
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    if (source.includes("manual") || source.includes("user"))
        return "explicit_manual";
    if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) {
        return "reflection_summary";
    }
    if (source.includes("experience") || source.includes("episode") || source.includes("playbook"))
        return "task_experience";
    if (source.includes("checkpoint") || source.includes("pressure-guard") || source.includes("pressure_guard")) {
        return "operational_checkpoint";
    }
    if (source.includes("capture") || source.includes("extract"))
        return "auto_capture";
    return "unknown_legacy";
}
export function previewLegacyMigrationV2(sqlitePath) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
        const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_truth'").get();
        if (!exists)
            return {
                schemaVersion: 2,
                readOnly: true,
                totalRows: 0,
                classifications: {},
                verificationDebt: 0,
                invalidMetadataRows: 0,
                attributionLanes: {},
            };
        const rows = db.prepare("SELECT metadata FROM memory_truth ORDER BY id").all();
        const classifications = {};
        let verificationDebt = 0;
        let invalidMetadataRows = 0;
        const attributionLanes = {};
        for (const row of rows) {
            let metadata = {};
            try {
                metadata = JSON.parse(row.metadata || "{}");
            }
            catch {
                invalidMetadataRows += 1;
            }
            const kind = classifyLegacySourceV2(metadata);
            classifications[kind] = (classifications[kind] ?? 0) + 1;
            const senderId = metadata.principalId ?? metadata.principal_id
                ?? metadata.senderId ?? metadata.sender_id ?? metadata.userId ?? metadata.user_id;
            const sessionEvidence = metadata.source_session ?? metadata.sessionKey ?? metadata.session_key
                ?? metadata.sessionId ?? metadata.session_id;
            const lane = senderId !== undefined && senderId !== null && String(senderId).trim()
                ? "resolved_principal"
                : sessionEvidence !== undefined && sessionEvidence !== null && String(sessionEvidence).trim()
                    ? "session_attribution_review"
                    : kind === "explicit_manual"
                        ? "manual_operator_review"
                        : kind === "reflection_summary" || kind === "operational_checkpoint"
                            ? "system_generated_review"
                            : "unattributed_quarantine";
            attributionLanes[lane] = (attributionLanes[lane] ?? 0) + 1;
            const verification = String(metadata.verification ?? metadata.verification_status ?? "");
            if (!verification || kind === "unknown_legacy")
                verificationDebt += 1;
        }
        return {
            schemaVersion: 2,
            readOnly: true,
            totalRows: rows.length,
            classifications,
            verificationDebt,
            invalidMetadataRows,
            attributionLanes,
        };
    }
    finally {
        db.close();
    }
}
