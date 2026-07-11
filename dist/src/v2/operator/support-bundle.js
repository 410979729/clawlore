const SENSITIVE_KEY = /(?:api.?key|token|password|secret|credential|cookie|authorization|private.?key)/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{8,})/i;
const LOCAL_PATH = /(?:^|\s)(?:\/home\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+)/;
function redactString(value) {
    if (SECRET_VALUE.test(value))
        return "<redacted-secret>";
    if (LOCAL_PATH.test(value))
        return "<redacted-local-path>";
    return value.length > 4_000 ? `${value.slice(0, 4_000)}<truncated>` : value;
}
export function redactSupportBundle(value, key = "") {
    if (SENSITIVE_KEY.test(key))
        return "<redacted-secret>";
    if (typeof value === "string")
        return redactString(value);
    if (Array.isArray(value))
        return value.map((item) => redactSupportBundle(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .map(([childKey, childValue]) => [childKey, redactSupportBundle(childValue, childKey)]));
    }
    return value;
}
export function buildSupportBundleV1(input) {
    return {
        schemaVersion: 1,
        pluginVersion: input.pluginVersion,
        runtimeMode: input.runtimeMode,
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        diagnostics: redactSupportBundle(input.diagnostics),
        redactionPolicy: "clawlore-support-v1",
    };
}
