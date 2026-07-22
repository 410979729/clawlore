import { createHash } from "node:crypto";
import { findSecret } from "./secret-redaction.js";
import { PERSISTED_SECRET_FIELD_MAP, } from "./persisted-secret-policy.js";
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}
function tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
export function scanPersistedSecretDatabase(db, kind) {
    const hits = [];
    const findings = [];
    const flaggedPayloads = new Set();
    let secretBearingRows = 0;
    let secretBearingFields = 0;
    for (const [table, requestedFields] of Object.entries(PERSISTED_SECRET_FIELD_MAP[kind])) {
        if (!tableExists(db, table))
            continue;
        const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
            .map((column) => String(column.name)));
        const fields = requestedFields.filter((field) => columns.has(field));
        if (fields.length === 0)
            continue;
        const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${quoteIdentifier(table)}`);
        const rowHits = new Set();
        const patternCounts = {};
        let tableFieldHits = 0;
        let scannedRows = 0;
        for (const row of rows.iterate()) {
            scannedRows += 1;
            for (const field of fields) {
                const raw = row[field];
                if (raw === null || raw === undefined || raw === "")
                    continue;
                const value = String(raw);
                const secret = findSecret(value);
                if (!secret)
                    continue;
                const rowid = Number(row.__rowid);
                hits.push({ table, field, rowid, pattern: secret.name, payloadSha256: sha256(value), value, row });
                rowHits.add(String(rowid));
                flaggedPayloads.add(sha256(value));
                tableFieldHits += 1;
                patternCounts[secret.name] = (patternCounts[secret.name] ?? 0) + 1;
            }
        }
        if (tableFieldHits > 0) {
            findings.push({
                table,
                scannedRows,
                secretBearingRows: rowHits.size,
                secretBearingFields: tableFieldHits,
                patternCounts,
            });
            secretBearingRows += rowHits.size;
            secretBearingFields += tableFieldHits;
        }
    }
    return {
        hits,
        summary: {
            secretBearingRows,
            secretBearingFields,
            uniqueFlaggedPayloads: flaggedPayloads.size,
            findings,
        },
    };
}
export { quoteIdentifier };
