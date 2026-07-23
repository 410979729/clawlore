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

const NETWORK_FAILURE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const SAFE_PROVIDER_CODES = new Set([
  "authentication_error",
  "authorization_error",
  "content_filter",
  "context_length_exceeded",
  "forbidden",
  "insufficient_quota",
  "invalid_api_key",
  "invalid_request_error",
  "model_not_found",
  "not_found_error",
  "overloaded_error",
  "permission_denied",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_too_large",
  "server_error",
  "unauthorized",
]);

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "ConnectTimeoutError",
  "TimeoutError",
]);

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return NETWORK_FAILURE_CODES.has(normalized) || SAFE_PROVIDER_CODES.has(normalized)
    ? normalized
    : undefined;
}

function safeErrorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return SAFE_ERROR_NAMES.has(normalized) ? normalized : undefined;
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  try {
    return error && typeof error === "object" && !Array.isArray(error)
      ? error as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function safeProperty(
  record: Record<string, unknown> | null,
  key: string,
): unknown {
  if (!record) return undefined;
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function numericStatus(
  record: Record<string, unknown> | null,
  visited = new WeakSet<object>(),
  depth = 0,
): number | undefined {
  if (!record || depth > 8 || visited.has(record)) return undefined;
  visited.add(record);
  for (const value of [
    safeProperty(record, "status"),
    safeProperty(record, "statusCode"),
  ]) {
    const status = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const response = errorRecord(safeProperty(record, "response"));
  if (response) return numericStatus(response, visited, depth + 1);
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
  const code = safeCode(safeProperty(record, "code"))
    ?? safeCode(safeProperty(record, "type"));
  const name = safeErrorName(safeProperty(record, "name"));
  const rawMessage = safeProperty(record, "message");
  const message = typeof rawMessage === "string" ? rawMessage : "";

  let category: LlmFailureCategory = "unknown";
  if (status === 401) category = "authentication";
  else if (status === 403) category = "authorization";
  else if (status === 404) category = "endpoint_or_model";
  else if (status === 408 || status === 504) category = "timeout";
  else if (status === 429) category = "rate_limit";
  else if (status !== undefined && status >= 500) category = "upstream_failure";
  else if (status !== undefined && status >= 400) category = "request_rejected";
  else if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) category = "timeout";
  else if (code && NETWORK_FAILURE_CODES.has(code)) {
    category = "network_failure";
  }

  return {
    category,
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
  };
}
