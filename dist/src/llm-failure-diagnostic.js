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
function safeCode(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    return NETWORK_FAILURE_CODES.has(normalized) || SAFE_PROVIDER_CODES.has(normalized)
        ? normalized
        : undefined;
}
function safeErrorName(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    return SAFE_ERROR_NAMES.has(normalized) ? normalized : undefined;
}
function errorRecord(error) {
    return error && typeof error === "object" && !Array.isArray(error)
        ? error
        : null;
}
function numericStatus(record) {
    if (!record)
        return undefined;
    for (const value of [record.status, record.statusCode]) {
        const status = typeof value === "number" ? value : Number(value);
        if (Number.isInteger(status) && status >= 100 && status <= 599)
            return status;
    }
    const response = errorRecord(record.response);
    if (response && response !== record)
        return numericStatus(response);
    return undefined;
}
/**
 * Convert an SDK/network error into a bounded diagnostic safe for logs and
 * governance ledgers. Error messages, response bodies, headers, URLs and
 * credentials are never returned.
 */
export function diagnoseLlmFailure(error) {
    const record = errorRecord(error);
    const status = numericStatus(record);
    const code = safeCode(record?.code) ?? safeCode(record?.type);
    const name = safeErrorName(record?.name)
        ?? (error instanceof Error ? safeErrorName(error.name) : undefined);
    const message = error instanceof Error ? error.message : "";
    let category = "unknown";
    if (status === 401)
        category = "authentication";
    else if (status === 403)
        category = "authorization";
    else if (status === 404)
        category = "endpoint_or_model";
    else if (status === 408 || status === 504)
        category = "timeout";
    else if (status === 429)
        category = "rate_limit";
    else if (status !== undefined && status >= 500)
        category = "upstream_failure";
    else if (status !== undefined && status >= 400)
        category = "request_rejected";
    else if (name === "AbortError" || /timeout|timed out|aborted/i.test(message))
        category = "timeout";
    else if (code && NETWORK_FAILURE_CODES.has(code)) {
        category = "network_failure";
    }
    return {
        category,
        ...(status === undefined ? {} : { status }),
        ...(code ? { code } : {}),
    };
}
