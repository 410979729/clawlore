export const DEFAULT_LANCE_SCAN_PAGE_SIZE = 1_000;
export const DEFAULT_LANCE_SCAN_MAX_ROWS = 100_000;

export interface LanceRecordBatch<Row> {
  toArray(): Iterable<Row>;
}

export interface LanceStreamingQuery<Row> extends AsyncIterable<LanceRecordBatch<Row>> {
  limit(value: number): this;
}

export interface LanceScanResult {
  scannedRows: number;
  truncated: boolean;
}

export interface LanceScanOptions {
  pageSize?: number;
  maxRows?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value as number)));
}

/**
 * Scan one Lance query snapshot with bounded consumer pages and one overflow
 * row. Reissuing offset queries is unsafe because a concurrent delete before
 * the current offset can silently skip a row while still reporting a complete
 * scan. A single async query keeps LanceDB's read snapshot stable and applies
 * backpressure without collecting the full table.
 */
export async function scanLanceRows<Row>(
  createQuery: () => LanceStreamingQuery<Row>,
  consume: (rows: Row[]) => void | Promise<void>,
  options: LanceScanOptions = {},
): Promise<LanceScanResult> {
  const maxRows = boundedInteger(
    options.maxRows,
    DEFAULT_LANCE_SCAN_MAX_ROWS,
    DEFAULT_LANCE_SCAN_MAX_ROWS,
  );
  const pageSize = boundedInteger(
    options.pageSize,
    DEFAULT_LANCE_SCAN_PAGE_SIZE,
    Math.min(DEFAULT_LANCE_SCAN_MAX_ROWS, maxRows),
  );
  const query = createQuery().limit(maxRows + 1);
  let page: Row[] = [];
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

  if (page.length > 0) await consume(page);
  return { scannedRows, truncated };
}

export async function collectLanceRows<Row>(
  createQuery: () => LanceStreamingQuery<Row>,
  options: LanceScanOptions = {},
): Promise<LanceScanResult & { rows: Row[] }> {
  const rows: Row[] = [];
  const result = await scanLanceRows(createQuery, (page) => {
    rows.push(...page);
  }, options);
  return { ...result, rows };
}
