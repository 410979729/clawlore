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
] as const;

export function redactDigestRunForDiagnostics(
  row: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!row) return {};
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_DIGEST_RUN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) safe[field] = row[field];
  }
  return safe;
}

export function redactDigestReportForDiagnostics(
  report: Record<string, unknown>,
): Record<string, unknown> {
  const { lastRun, samples: _samples, ...safe } = report;
  return {
    ...safe,
    ...(lastRun && typeof lastRun === "object" && !Array.isArray(lastRun)
      ? { lastRun: redactDigestRunForDiagnostics(lastRun as Record<string, unknown>) }
      : {}),
  };
}
