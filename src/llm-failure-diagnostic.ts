export type LlmFailureCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "endpoint_or_model"
  | "request_rejected"
  | "upstream_failure"
  | "network_failure"
  | "empty_response"
  | "invalid_response"
  | "unknown";

export interface LlmFailureDiagnostic {
  category: LlmFailureCategory;
  status?: number;
  code?: string;
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  return safe || undefined;
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
}

function numericStatus(record: Record<string, unknown> | null): number | undefined {
  if (!record) return undefined;
  for (const value of [record.status, record.statusCode]) {
    const status = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const response = errorRecord(record.response);
  if (response && response !== record) return numericStatus(response);
  return undefined;
}

/**
 * Convert an SDK/network error into a bounded diagnostic safe for logs and
 * governance ledgers. Error messages, response bodies, headers, URLs and
 * credentials are never returned.
 */
export function diagnoseLlmFailure(error: unknown): LlmFailureDiagnostic {
  const record = errorRecord(error);
  const status = numericStatus(record);
  const code = safeCode(record?.code) ?? safeCode(record?.type);
  const name = safeCode(record?.name) ?? (error instanceof Error ? safeCode(error.name) : undefined);
  const message = error instanceof Error ? error.message : "";

  let category: LlmFailureCategory = "unknown";
  if (status === 401) category = "authentication";
  else if (status === 403) category = "authorization";
  else if (status === 404) category = "endpoint_or_model";
  else if (status === 408 || status === 504) category = "timeout";
  else if (status === 429) category = "rate_limit";
  else if (status !== undefined && status >= 500) category = "upstream_failure";
  else if (status !== undefined && status >= 400) category = "request_rejected";
  else if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) category = "timeout";
  else if (code && /^(?:ECONN|ENET|EHOST|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)) {
    category = "network_failure";
  }

  return {
    category,
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
  };
}
