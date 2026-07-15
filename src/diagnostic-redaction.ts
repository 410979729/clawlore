import { createHmac, randomBytes } from "node:crypto";

// Process-local keyed hashes keep low-entropy identifiers (chat ids, account
// names, paths) from being reversible through a small dictionary. Correlation
// remains possible within one runtime without creating a durable identifier.
const DIAGNOSTIC_HASH_KEY = randomBytes(32);

export function diagnosticHash(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!text.trim()) return "none";
  return createHmac("sha256", DIAGNOSTIC_HASH_KEY).update(text, "utf8").digest("hex").slice(0, 12);
}

export function diagnosticIdentifier(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return text ? `hash=${diagnosticHash(text)}` : "none";
}

export function diagnosticTextSummary(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return `len=${text.length},hash=${diagnosticHash(text)}`;
}

export function diagnosticContentSummary(content: unknown): string {
  if (typeof content === "string") return `string(${diagnosticTextSummary(content)})`;
  if (Array.isArray(content)) {
    const textBlocks: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        textBlocks.push(String((block as Record<string, unknown>).text));
      }
    }
    const combined = textBlocks.join(" ");
    return `array(blocks=${content.length},textBlocks=${textBlocks.length},${diagnosticTextSummary(combined)})`;
  }
  return `type=${Array.isArray(content) ? "array" : typeof content}`;
}

export function diagnosticErrorSummary(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name.replace(/[^a-zA-Z0-9_.-]/g, "") : "Error";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return `${name}(len=${message.length},hash=${diagnosticHash(message)})`;
}
