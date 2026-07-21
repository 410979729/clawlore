import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
} from "yaml";

export interface StructuredSecretSpan {
  key: string;
  start: number;
  end: number;
  value: string;
}

const SECRET_KEY_SUFFIXES = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "pwd",
  "secret",
  "token",
]);

const SECRET_KEY_COMPOUND_SUFFIXES = [
  "access_key",
  "api_key",
  "auth_token",
  "client_secret",
  "client_key",
  "encryption_key",
  "hmac_key",
  "master_key",
  "private_key",
  "recovery_key",
  "recovery_code",
  "refresh_token",
  "secret_access_key",
  "secret_key",
  "shared_access_signature",
  "signing_key",
];

const CJK_SECRET_KEYS = new Set([
  "凭证",
  "口令",
  "密码",
  "密钥",
  "登录密码",
  "访问令牌",
  "远程密码",
  "令牌",
]);

function unquoteKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /["'`]/.test(trimmed[0] ?? "") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Canonicalize serializer and naming-style differences before applying the
 * secret-key policy. This is the single owner for snake_case, kebab-case,
 * dotted, namespaced, and camelCase credential keys.
 */
export function normalizeStructuredSecretKey(value: string): string {
  return unquoteKey(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function isStructuredSecretKey(value: string): boolean {
  if (CJK_SECRET_KEYS.has(unquoteKey(value))) return true;
  const normalized = normalizeStructuredSecretKey(value);
  if (!normalized) return false;
  const parts = normalized.split("_").filter(Boolean);
  const finalPart = parts.at(-1) ?? "";
  if (SECRET_KEY_SUFFIXES.has(finalPart)) return true;
  if (SECRET_KEY_COMPOUND_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`))) {
    return true;
  }

  // Environment-style keys are commonly all-caps without a separator before
  // the suffix (for example DATABASEPASSWORD). Preserve that compatibility
  // without treating policy keys such as passwordLength as credentials.
  return /^[A-Z][A-Z0-9]*$/.test(unquoteKey(value))
    && /(?:PASSWORD|PASSWD|TOKEN|SECRET|APIKEY|PRIVATEKEY|CLIENTSECRET|ACCESSKEY|REFRESHTOKEN|AUTHTOKEN|COOKIE)$/.test(unquoteKey(value));
}

function nodeRange(value: unknown): [number, number] | null {
  if (!value || typeof value !== "object") return null;
  const range = (value as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = Number(range[0]);
  const end = Number(range[1]);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start
    ? [start, end]
    : null;
}

function scalarText(value: unknown): string | null {
  if (!isScalar(value)) return null;
  const scalar = value.value;
  if (scalar == null) return "";
  if (typeof scalar === "string") return scalar;
  if (typeof scalar === "number" || typeof scalar === "boolean" || typeof scalar === "bigint") {
    return String(scalar);
  }
  return null;
}

function collectYamlSpans(text: string): StructuredSecretSpan[] {
  const spans: StructuredSecretSpan[] = [];
  let documents;
  try {
    documents = parseAllDocuments(text, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: false,
    });
  } catch {
    return spans;
  }

  const visit = (node: unknown, document: (typeof documents)[number]): void => {
    if (isPair(node)) {
      const key = scalarText(node.key);
      if (key && isStructuredSecretKey(key) && node.value != null) {
        // A secret-keyed alias is only safe when the anchored source is also
        // redacted. Replacing `*alias` alone leaves the actual credential at
        // its anchor declaration, which is still present in support bundles
        // and task transcripts.
        let valueNode = node.value;
        if (isAlias(valueNode)) {
          try {
            valueNode = valueNode.resolve(document) ?? valueNode;
          } catch {
            // The fallback scanner still redacts the alias reference. Invalid
            // or cyclic YAML is never trusted as a successfully parsed value.
          }
        }
        const range = nodeRange(valueNode);
        if (range && range[1] <= text.length) {
          const parsedValue = scalarText(valueNode);
          spans.push({
            key,
            start: range[0],
            end: range[1],
            value: parsedValue ?? text.slice(range[0], range[1]),
          });
        }
      }
      visit(node.value, document);
      return;
    }
    if (isMap(node) || isSeq(node)) {
      for (const item of node.items) visit(item, document);
    }
  };

  for (const document of documents) {
    if (document.errors.length === 0) visit(document.contents, document);
  }
  return spans;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function leadingIndent(text: string, offset: number): number {
  const start = lineStart(text, offset);
  let cursor = start;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
  return cursor - start;
}

function readQuotedValue(text: string, start: number): number {
  const quote = text[start];
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  if (triple) {
    const end = text.indexOf(quote.repeat(3), start + 3);
    return end < 0 ? text.length : end + 3;
  }
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) return cursor + 1;
  }
  return text.length;
}

function readYamlBlockValue(text: string, start: number, keyOffset: number): number | null {
  // YAML permits chomping and indentation indicators in either order (`|-2`
  // and `|2-`) and may append a comment to the header line.
  const marker = /^[>|](?:(?:[+-]\d?)|(?:\d[+-]?))?[^\r\n]*(?:\r?\n|$)/.exec(text.slice(start));
  if (!marker) return null;
  const keyIndent = leadingIndent(text, keyOffset);
  let cursor = start + marker[0].length;
  let end = cursor;
  while (cursor < text.length) {
    const nextNewline = text.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? text.length : nextNewline + 1;
    const line = text.slice(cursor, lineEnd).replace(/\r?\n$/, "");
    if (line.trim() && leadingIndent(text, cursor) <= keyIndent) break;
    end = lineEnd;
    cursor = lineEnd;
  }
  return end;
}

function readFallbackValue(text: string, start: number, keyOffset: number): number {
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") return readQuotedValue(text, start);
  const blockEnd = readYamlBlockValue(text, start, keyOffset);
  if (blockEnd != null) return blockEnd;

  let cursor = start;
  while (cursor < text.length && !/[\r\n,;\]}]/.test(text[cursor] ?? "")) cursor++;
  while (cursor > start && /\s/.test(text[cursor - 1] ?? "")) cursor--;
  return cursor;
}

function collectXmlAttributeSpans(text: string): StructuredSecretSpan[] {
  const spans: StructuredSecretSpan[] = [];
  const tag = /<([A-Za-z][A-Za-z0-9_.:-]*)\b([^<>]*?)\/?\s*>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tag.exec(text)) !== null) {
    const attributesText = tagMatch[2] ?? "";
    const attributesOffset = tagMatch.index + tagMatch[0].indexOf(attributesText);
    const attributes: Array<{ name: string; value: string; start: number; end: number }> = [];
    const attribute = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attribute.exec(attributesText)) !== null) {
      const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
      const raw = attributeMatch[0];
      const valueOffset = raw.lastIndexOf(value);
      const start = attributesOffset + attributeMatch.index + valueOffset;
      attributes.push({
        name: attributeMatch[1] ?? "",
        value,
        start,
        end: start + value.length,
      });
      if (attributeMatch[0].length === 0) attribute.lastIndex += 1;
    }

    for (const candidate of attributes) {
      if (isStructuredSecretKey(candidate.name) && candidate.value) {
        spans.push({ key: candidate.name, start: candidate.start, end: candidate.end, value: candidate.value });
      }
    }

    const semanticKey = attributes.find((candidate) =>
      ["key", "name"].includes(normalizeStructuredSecretKey(candidate.name))
      && isStructuredSecretKey(candidate.value));
    if (semanticKey) {
      for (const candidate of attributes) {
        if (normalizeStructuredSecretKey(candidate.name) === "value" && candidate.value) {
          spans.push({ key: semanticKey.value, start: candidate.start, end: candidate.end, value: candidate.value });
        }
      }
    }
  }
  return spans;
}

function collectNpmrcSpans(text: string): StructuredSecretSpan[] {
  const spans: StructuredSecretSpan[] = [];
  const assignment = /(?:^|\r?\n)[\t ]*(?:\/\/[^\r\n=]*\/:)?([_A-Za-z][A-Za-z0-9_.-]*)[\t ]*=[\t ]*/gm;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(text)) !== null) {
    const key = match[1] ?? "";
    const normalizedKey = normalizeStructuredSecretKey(key);
    if (!isStructuredSecretKey(key) && normalizedKey !== "auth") continue;
    const start = match.index + match[0].length;
    const lineEnd = text.indexOf("\n", start);
    let end = lineEnd < 0 ? text.length : lineEnd;
    if (end > start && text[end - 1] === "\r") end -= 1;
    while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
    if (end > start) spans.push({ key, start, end, value: text.slice(start, end) });
  }
  return spans;
}

/**
 * Parse valid YAML/JSON first, then scan embedded config fragments that cannot
 * form a standalone document (for example prose containing `serviceToken=...`).
 * Both routes use the same normalized-key policy and return exact value spans
 * so every consumer can redact the original bytes rather than merely flagging.
 */
export function findStructuredSecretSpans(text: string): StructuredSecretSpan[] {
  const spans = [
    ...collectYamlSpans(text),
    ...collectXmlAttributeSpans(text),
    ...collectNpmrcSpans(text),
  ];
  const assignment = /(?:^|[\s,;{[(])(["'`]?(?:[A-Za-z][A-Za-z0-9_.-]*|凭证|口令|密码|密钥|登录密码|访问令牌|远程密码|令牌)["'`]?)\s*[:=]\s*/gm;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(text)) !== null) {
    const key = match[1] ?? "";
    if (!isStructuredSecretKey(key)) continue;
    const keyOffset = match.index + match[0].indexOf(key);
    const start = match.index + match[0].length;
    const end = readFallbackValue(text, start, keyOffset);
    if (end > start) spans.push({ key: unquoteKey(key), start, end, value: text.slice(start, end) });
    if (match[0].length === 0) assignment.lastIndex += 1;
  }

  // XML-style configuration is common in Java/.NET operators and cannot be
  // parsed as YAML. Use the same normalized key policy and redact the complete
  // element value, including CDATA or multiline content.
  const xmlOpen = /<([A-Za-z][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?>/gi;
  while ((match = xmlOpen.exec(text)) !== null) {
    const key = match[1] ?? "";
    if (!isStructuredSecretKey(key)) continue;
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const close = new RegExp(`<\\/${escapedKey}\\s*>`, "i");
    const remainder = text.slice(xmlOpen.lastIndex);
    const closing = close.exec(remainder);
    if (!closing || closing.index <= 0) continue;
    const start = xmlOpen.lastIndex;
    const end = start + closing.index;
    spans.push({ key, start, end, value: text.slice(start, end) });
  }

  return spans
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((span, index, all) => !all.slice(0, index).some((prior) => prior.start <= span.start && prior.end >= span.end));
}
