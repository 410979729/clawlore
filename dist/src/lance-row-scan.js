export const DEFAULT_LANCE_SCAN_PAGE_SIZE = 1_000;
export const DEFAULT_LANCE_SCAN_MAX_ROWS = 100_000;
function boundedInteger(value, fallback, maximum) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(value)));
}
/**
 * Scan one Lance query snapshot with bounded consumer pages and one overflow
 * row. Reissuing offset queries is unsafe because a concurrent delete before
 * the current offset can silently skip a row while still reporting a complete
 * scan. A single async query keeps LanceDB's read snapshot stable and applies
 * backpressure without collecting the full table.
 */
export async function scanLanceRows(createQuery, consume, options = {}) {
    const maxRows = boundedInteger(options.maxRows, DEFAULT_LANCE_SCAN_MAX_ROWS, DEFAULT_LANCE_SCAN_MAX_ROWS);
    const pageSize = boundedInteger(options.pageSize, DEFAULT_LANCE_SCAN_PAGE_SIZE, Math.min(DEFAULT_LANCE_SCAN_MAX_ROWS, maxRows));
    const query = createQuery().limit(maxRows + 1);
    let page = [];
    let scannedRows = 0;
    let truncated = false;
    scan: for await (const batch of query) {
        for (const row of batch.toArray()) {
            if (scannedRows >= maxRows) {
                truncated = true;
                break scan;
            }
            page.push(row);
            scannedRows += 1;
            if (page.length >= pageSize) {
                await consume(page);
                page = [];
            }
        }
    }
    if (page.length > 0)
        await consume(page);
    return { scannedRows, truncated };
}
export async function collectLanceRows(createQuery, options = {}) {
    const rows = [];
    const result = await scanLanceRows(createQuery, (page) => {
        rows.push(...page);
    }, options);
    return { ...result, rows };
}
