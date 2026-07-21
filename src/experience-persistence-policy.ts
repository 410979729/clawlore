import { containsSecret } from "./secret-redaction.js";

const MAX_EXPERIENCE_WRITE_BYTES = 256 * 1024;

/**
 * Final fail-closed guard for every Experience Kernel SQL write. Callers may
 * add stricter model validation, but no public helper may persist text or
 * nested structured data before this canonical secret-policy check succeeds.
 */
export function assertExperiencePersistenceSafe(value: unknown, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (serialized == null) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPERIENCE_WRITE_BYTES) {
    throw new Error(`${label} exceeds the persistence size limit`);
  }
  if (containsSecret(serialized)) {
    throw new Error(`${label} rejected by Experience persistence safety policy`);
  }

  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number`);
      continue;
    }
    if (typeof current === "string") {
      if (containsSecret(current)) {
        throw new Error(`${label} rejected by Experience persistence safety policy`);
      }
      continue;
    }
    if (typeof current !== "object") {
      if (typeof current === "undefined") continue;
      throw new Error(`${label} contains an unsupported value`);
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (containsSecret(key)) {
        throw new Error(`${label} rejected by Experience persistence safety policy`);
      }
      pending.push(item);
    }
  }
}
