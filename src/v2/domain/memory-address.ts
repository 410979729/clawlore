export type MemoryVisibility = "private" | "conversation" | "project" | "team" | "global";

export type MemoryRetention = "ephemeral" | "working" | "durable";

export interface MemoryAddressV2 {
  schemaVersion: 2;
  tenantId: string;
  principalId: string;
  agentId: string;
  workspaceId?: string;
  projectId?: string;
  platform?: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string;
  customerId?: string;
  taskId?: string;
  visibility: MemoryVisibility;
  retention: MemoryRetention;
}

export type MemoryAddressField = keyof MemoryAddressV2;

export interface MemoryAddressValidation {
  valid: boolean;
  errors: Array<{
    field: MemoryAddressField;
    code: "required" | "too_long" | "invalid_visibility_boundary";
    message: string;
  }>;
}

const MAX_ID_CHARS = 512;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateIdentifier(
  address: MemoryAddressV2,
  field: MemoryAddressField,
  required: boolean,
  errors: MemoryAddressValidation["errors"],
): void {
  const value = address[field];
  if (required && !hasText(value)) {
    errors.push({ field, code: "required", message: `${field} is required` });
    return;
  }
  if (hasText(value) && value.length > MAX_ID_CHARS) {
    errors.push({ field, code: "too_long", message: `${field} exceeds ${MAX_ID_CHARS} characters` });
  }
}

export function validateMemoryAddress(address: MemoryAddressV2): MemoryAddressValidation {
  const errors: MemoryAddressValidation["errors"] = [];
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
  ] as const) {
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

export function memoryAddressKey(address: MemoryAddressV2): string {
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
