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
    code: "required" | "too_long" | "invalid_format" | "invalid_enum" | "invalid_visibility_boundary";
    message: string;
  }>;
}

const MAX_ID_CHARS = 512;
const VISIBILITIES = new Set<MemoryVisibility>(["private", "conversation", "project", "team", "global"]);
const RETENTIONS = new Set<MemoryRetention>(["ephemeral", "working", "durable"]);

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
  if (hasText(value) && (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) {
    errors.push({ field, code: "invalid_format", message: `${field} must be trimmed and contain no control characters` });
  }
}

export function validateMemoryAddress(address: MemoryAddressV2): MemoryAddressValidation {
  const errors: MemoryAddressValidation["errors"] = [];
  if (!address || typeof address !== "object") {
    return {
      valid: false,
      errors: [{ field: "schemaVersion", code: "required", message: "memory address object is required" }],
    };
  }
  if (address.schemaVersion !== 2) {
    errors.push({ field: "schemaVersion", code: "invalid_enum", message: "schemaVersion must equal 2" });
  }
  validateIdentifier(address, "tenantId", true, errors);
  validateIdentifier(address, "principalId", true, errors);
  validateIdentifier(address, "agentId", true, errors);

  if (!VISIBILITIES.has(address.visibility)) {
    errors.push({ field: "visibility", code: "invalid_enum", message: "visibility is unsupported" });
  }
  if (!RETENTIONS.has(address.retention)) {
    errors.push({ field: "retention", code: "invalid_enum", message: "retention is unsupported" });
  }

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
