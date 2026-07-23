export const DEFAULT_LANCE_SCAN_PAGE_SIZE = 1_000;
export const DEFAULT_LANCE_SCAN_MAX_ROWS = 100_000;
function boundedInteger(value, fallback, maximum) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(value)));
}
/**
 * Scan a Lance query in bounded pages and probe one row beyond the total
 * budget. Callers can fail closed instead of silently treating a partial scan
 * as complete.
 */
export async function scanLanceRows(createQuery, consume, options = {}) {
    const maxRows = boundedInteger(options.maxRows, DEFAULT_LANCE_SCAN_MAX_ROWS, DEFAULT_LANCE_SCAN_MAX_ROWS);
    const pageSize = boundedInteger(options.pageSize, DEFAULT_LANCE_SCAN_PAGE_SIZE, Math.min(DEFAULT_LANCE_SCAN_MAX_ROWS, maxRows));
    let scannedRows = 0;
    while (scannedRows < maxRows) {
        const requested = Math.min(pageSize, maxRows - scannedRows);
        const rows = await createQuery()
            .limit(requested)
            .offset(scannedRows)
            .toArray();
        if (rows.length > requested) {
            throw new Error("CLAWLORE_LANCE_SCAN_PAGE_LIMIT_IGNORED");
        }
        if (rows.length === 0)
            return { scannedRows, truncated: false };
        await consume(rows);
        scannedRows += rows.length;
        if (rows.length < requested)
            return { scannedRows, truncated: false };
    }
    const overflow = await createQuery()
        .limit(1)
        .offset(scannedRows)
        .toArray();
    return { scannedRows, truncated: overflow.length > 0 };
}
export async function collectLanceRows(createQuery, options = {}) {
    const rows = [];
    const result = await scanLanceRows(createQuery, (page) => {
        rows.push(...page);
    }, options);
    return { ...result, rows };
}
