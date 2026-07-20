import { evaluateCaptureSafety } from "./capture-safety.js";

const ALLOWED_SECRET_TYPES = new Set(["password", "token", "api_key", "private_key", "cookie", "credential", "other"]);

function compactText(value: unknown, maxChars: number): string {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : text;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return [];
}

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

function secretType(value: unknown): string {
  const normalized = String(value || "credential").trim().toLowerCase().replace(/-/g, "_");
  return ALLOWED_SECRET_TYPES.has(normalized) ? normalized : "other";
}

function fingerprint(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("secret index fingerprint must be a locally generated 64-character SHA-256 digest");
  }
  return normalized.slice(0, 16);
}

function safeIndexField(field: string, value: unknown, maxChars: number): string {
  const text = compactText(value, maxChars);
  if (!text) return "";
  const decision = evaluateCaptureSafety(text);
  if (!decision.allowed) {
    throw new Error(
      `secret index field '${field}' rejected by capture safety filter (${decision.reason}${decision.pattern ? `:${decision.pattern}` : ""})`,
    );
  }
  return text;
}

function safeIndexList(field: string, value: unknown, maxChars: number): string[] {
  return stringList(value).map((item) => safeIndexField(field, item, maxChars)).filter(Boolean);
}

export function buildSecretIndex(args: Record<string, unknown>): { content: string; metadata: Record<string, unknown> } {
  const label = safeIndexField("label", args.label || args.name, 160);
  const service = safeIndexField("service", args.service, 120);
  const account = safeIndexField("account", args.account, 120);
  const username = safeIndexField("username", args.username, 120);
  const hostname = safeIndexField("hostname", args.hostname, 120);
  const vaultRef = safeIndexField("vaultRef", args.vaultRef || args.vault_ref || args.locator, 260);
  const notes = safeIndexField("notes", args.notes, 300);
  const rotationDue = safeIndexField("rotationDue", args.rotationDue || args.rotation_due || args.expires_at, 80);
  const kind = secretType(args.secretType || args.secret_type || args.type);
  const secretFingerprint = fingerprint(
    args.secretFingerprintSha256 || args.secret_fingerprint_sha256,
  );
  const safeLabel = label || service || account || vaultRef || "unnamed credential";

  const lines = [`Secret index: ${safeLabel}`, `Kind: ${kind}`];
  if (service) lines.push(`Service: ${service}`);
  if (account) lines.push(`Account: ${account}`);
  if (username) lines.push(`Username: ${username}`);
  if (hostname) lines.push(`Host: ${hostname}`);
  lines.push(vaultRef ? `Vault ref: ${vaultRef}` : "Vault ref: [not provided]");
  if (rotationDue) lines.push(`Rotation due: ${rotationDue}`);
  if (secretFingerprint) lines.push(`Secret fingerprint: sha256:${secretFingerprint}`);
  if (notes) lines.push(`Notes: ${notes}`);
  lines.push("Plaintext secret value: [never accepted by ClawLore]");

  const entities = [safeLabel, service, account, username, hostname, vaultRef, ...safeIndexList("entities", args.entities, 160)]
    .map((item) => normalizeEntity(item))
    .filter(Boolean);
  const tags = ["secret-index", "credential", `secret-type:${kind}`, ...safeIndexList("tags", args.tags, 120)]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const metadata: Record<string, unknown> = {
    memory_type: "resource",
    importance: 0.82,
    sensitivity: "secret-index",
    secret_storage: "external-vault-reference",
    secret_value_stored: false,
    secret_type: kind,
    secret_value_sha256_prefix: secretFingerprint,
    entities: [...new Set(entities)].sort(),
    tags: [...new Set(tags)].sort(),
  };
  if (vaultRef) metadata.vault_ref = vaultRef;
  if (service) metadata.service = service;
  if (account) metadata.account = account;
  if (rotationDue) metadata.rotation_due = rotationDue;
  return { content: lines.join("\n"), metadata };
}
