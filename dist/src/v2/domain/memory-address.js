const MAX_ID_CHARS = 512;
function hasText(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function validateIdentifier(address, field, required, errors) {
    const value = address[field];
    if (required && !hasText(value)) {
        errors.push({ field, code: "required", message: `${field} is required` });
        return;
    }
    if (hasText(value) && value.length > MAX_ID_CHARS) {
        errors.push({ field, code: "too_long", message: `${field} exceeds ${MAX_ID_CHARS} characters` });
    }
}
export function validateMemoryAddress(address) {
    const errors = [];
    validateIdentifier(address, "tenantId", true, errors);
    validateIdentifier(address, "principalId", true, errors);
    validateIdentifier(address, "agentId", true, errors);
    for (const field of [
        "workspaceId",
        "projectId",
        "platform",
        "accountId",
        "conversationId",
        "threadId",
        "customerId",
        "taskId",
    ]) {
        validateIdentifier(address, field, false, errors);
    }
    if (address.visibility === "conversation" && !hasText(address.conversationId)) {
        errors.push({
            field: "conversationId",
            code: "invalid_visibility_boundary",
            message: "conversation visibility requires conversationId",
        });
    }
    if (address.visibility === "project" && !hasText(address.projectId)) {
        errors.push({
            field: "projectId",
            code: "invalid_visibility_boundary",
            message: "project visibility requires projectId",
        });
    }
    return { valid: errors.length === 0, errors };
}
export function memoryAddressKey(address) {
    const fields = [
        address.schemaVersion,
        address.tenantId,
        address.principalId,
        address.agentId,
        address.workspaceId ?? "",
        address.projectId ?? "",
        address.platform ?? "",
        address.accountId ?? "",
        address.conversationId ?? "",
        address.threadId ?? "",
        address.customerId ?? "",
        address.taskId ?? "",
        address.visibility,
        address.retention,
    ];
    return fields.map((value) => encodeURIComponent(String(value))).join("|");
}
