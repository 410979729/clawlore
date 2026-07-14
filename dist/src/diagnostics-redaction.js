const SAFE_DIGEST_RUN_FIELDS = [
    "run_date",
    "started_at",
    "completed_at",
    "status",
    "source_count",
    "chunk_count",
    "candidate_count",
    "stored_count",
    "skipped_count",
    "error_count",
];
export function redactDigestRunForDiagnostics(row) {
    if (!row)
        return {};
    const safe = {};
    for (const field of SAFE_DIGEST_RUN_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(row, field))
            safe[field] = row[field];
    }
    return safe;
}
export function redactDigestReportForDiagnostics(report) {
    const { lastRun, samples: _samples, ...safe } = report;
    return {
        ...safe,
        ...(lastRun && typeof lastRun === "object" && !Array.isArray(lastRun)
            ? { lastRun: redactDigestRunForDiagnostics(lastRun) }
            : {}),
    };
}
