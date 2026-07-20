import { findStructuredSecretSpans } from "./secret-structured-text.js";

export interface SecretFinding {
  name: string;
}

type SecretPattern = {
  name: string;
  re: RegExp;
  valueIndex?: number;
};

const EXACT_PLACEHOLDER_VALUES = new Set([
  "changeme",
  "change-me",
  "change_me",
  "dummy",
  "example",
  "placeholder",
  "redacted",
  "test-key",
  "test_key",
  "test-placeholder",
  "your-key",
  "your_key",
  "your-token",
  "your_token",
]);

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/^["'`]|["'`]$/g, "");
  const lower = normalized.toLowerCase();
  if (!normalized) return true;
  if (EXACT_PLACEHOLDER_VALUES.has(lower)) return true;
  if (/^\$\{[A-Za-z0-9_.:-]+\}$/.test(normalized)) return true;
  if (/^\{\{\s*[A-Za-z0-9_.:-]+\s*\}\}$/.test(normalized)) return true;
  if (/^\[REDACTED_[A-Z0-9_]+\]?$/i.test(normalized)) return true;
  if (/^(?:[A-Za-z0-9_-]+[-_])?(?:\.{3}|\*{4,})$/.test(normalized)) return true;
  if (/^(?:\[|<)?(?:redacted|placeholder|secret|token|password)(?:\]|>)?$/i.test(normalized)) return true;
  return /^(?:your|example|dummy|test)[-_]?(?:api[-_]?key|key|token|secret|password|credential)(?:[-_]?(?:placeholder|not[-_]?real))?$/i
    .test(normalized);
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  },
  {
    name: "putty-private-key-block",
    re: /PuTTY-User-Key-File-[^\r\n]*[\s\S]*?(?=\r?\n\r?\n|$)/gi,
  },
  {
    name: "authorization-bearer",
    re: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{8,})(?=$|\s|[,;])/gi,
    valueIndex: 1,
  },
  {
    name: "authorization-basic",
    re: /\b(?:Proxy-)?Authorization\s*:\s*Basic\s+([A-Za-z0-9+/]{6,}={0,2})(?=$|\s|[,;])/gi,
    valueIndex: 1,
  },
  {
    // Cover challenge/response and provider-specific authorization schemes
    // (Digest, AWS4-HMAC-SHA256, Negotiate, etc.), including a header nested
    // in JSON where inner quotes are backslash-escaped.
    name: "authorization-header",
    re: /\b(?:Proxy-)?Authorization\s*:\s*((?:(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})|[^\r\n"\\]){6,})/gi,
    valueIndex: 1,
  },
  {
    name: "http-cookie-header",
    re: /\b(?:Set-)?Cookie\s*:\s*([^\r\n]{6,})/gi,
    valueIndex: 1,
  },
  {
    name: "credentialed-url",
    re: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]+)@[^/\s]+/gi,
    valueIndex: 1,
  },
  {
    name: "env-secret-assignment",
    re: /(?:^|[\s;,({])(?:export\s+)?[A-Za-z][A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY|REFRESH_TOKEN|AUTH_TOKEN|COOKIE)\s*=\s*["'`]?([^"'`\s,;)}\]]{6,})/gim,
    valueIndex: 1,
  },
  {
    // Config fragments frequently arrive as YAML or JSON embedded in prose.
    // Match namespace-style keys independently of the surrounding serializer;
    // every capture/redaction consumer shares this one policy owner.
    name: "structured-secret-assignment",
    re: /(?:^|[\s,;{[(])["'`]?[A-Za-z][A-Za-z0-9_.-]*?(?:[_-](?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY|REFRESH_TOKEN|AUTH_TOKEN|COOKIE))["'`]?\s*[:=]\s*["'`]?([^"'`\s,;)}\]]{6,})/gim,
    valueIndex: 1,
  },
  {
    name: "command-line-secret-option-quoted",
    re: /(?:^|\s)--(?:api[-_]?key|auth[-_]?token|client[-_]?secret|password|passphrase|private[-_]?key|refresh[-_]?token|secret|token)\s*(?:=|\s)\s*(["'`])([^"'`\r\n]{6,})\1/gim,
    valueIndex: 2,
  },
  {
    name: "command-line-secret-option",
    re: /(?:^|\s)--(?:api[-_]?key|auth[-_]?token|client[-_]?secret|password|passphrase|private[-_]?key|refresh[-_]?token|secret|token)\s*(?:=|\s)\s*([^\s"'`,;)}\]]{6,})/gim,
    valueIndex: 1,
  },
  {
    name: "command-line-basic-credential-quoted",
    re: /(?:^|\s)(?:-u|--user)\s+(["'`])[^:\s"'`]+:([^"'`\r\n]{6,})\1/gim,
    valueIndex: 2,
  },
  {
    name: "command-line-basic-credential",
    re: /(?:^|\s)(?:-u|--user)\s+[^:\s"'`]+:([^\s"'`]{6,})/gim,
    valueIndex: 1,
  },
  {
    name: "password-assignment-quoted",
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*["'`]([^"'`\r\n]{6,})["'`]/gi,
    valueIndex: 1,
  },
  {
    name: "password-assignment-unquoted",
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*([^\s"',;)}\]]{6,})/gi,
    valueIndex: 1,
  },
  {
    name: "secret-assignment",
    re: /\b(?:api[_-]?key|apikey|secret|token|private[_-]?key|client[_-]?secret|access[_-]?key|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|auth[_-]?token)\b\s*[:=]\s*["'`]?([A-Za-z0-9_./+=:@-]{8,})/gi,
    valueIndex: 1,
  },
  {
    name: "credential-pair-with-password",
    re: /(?:账号|用户名|用户|user(?:name)?|login)\s*(?:是|为|[:：=])\s*["'`]?[^\s"'`，。；;,)}\]]{2,}["'`]?(?:(?:[\s,，;；]+)|.{0,20})(?:密码|口令|password|passwd|pwd)\s*(?:是|为|[:：=])\s*["'`]?([^\s"'`，。；;,)}\]]{6,})/giu,
    valueIndex: 1,
  },
  {
    name: "chinese-password-assignment",
    re: /(?:密码|口令|登录密码|远程密码)\s*(?:是|为|[:：=])\s*["'`]?([^\s"'`，。；;,)}\]]{6,})/giu,
    valueIndex: 1,
  },
  {
    name: "chinese-secret-assignment",
    re: /(?:(?<![A-Za-z0-9_])(?:api\s*key|apikey|secret|token)(?![A-Za-z0-9_])|密钥|令牌|访问令牌|凭证)\s*(?:是|为|[:：=])\s*["'`]?([A-Za-z0-9_./+=:@-]{8,})/giu,
    valueIndex: 1,
  },
  { name: "openai-style-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "stripe-secret-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "google-oauth-token", re: /\b(?:ya29\.[A-Za-z0-9_-]{16,}|1\/\/[A-Za-z0-9_-]{16,})\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: "twilio-api-key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{40,}\b/g },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: "digitalocean-token", re: /\bdop_v1_[a-fA-F0-9]{64}\b/g },
  { name: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

function secretValue(pattern: SecretPattern, match: RegExpExecArray): string {
  return pattern.valueIndex ? match[pattern.valueIndex] ?? "" : match[0] ?? "";
}

function parseJsonContainer(text: string): unknown | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function visitJsonStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visit);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) visitJsonStrings(item, visit);
  }
}

function mapJsonStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, mapJsonStrings(item, transform)]));
  }
  return value;
}

function findDirectSecret(text: string): SecretFinding | null {
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(text)) !== null) {
      const value = secretValue(pattern, match);
      if (!value || !looksLikePlaceholder(value)) {
        pattern.re.lastIndex = 0;
        return { name: pattern.name };
      }
      if (match[0].length === 0) pattern.re.lastIndex += 1;
    }
    pattern.re.lastIndex = 0;
  }
  for (const span of findStructuredSecretSpans(text)) {
    if (!looksLikePlaceholder(span.value)) return { name: "structured-secret-assignment" };
  }
  return null;
}

export function findSecret(text: string): SecretFinding | null {
  const direct = findDirectSecret(text);
  if (direct) return direct;
  const parsed = parseJsonContainer(text);
  let nested: SecretFinding | null = null;
  if (parsed) visitJsonStrings(parsed, (value) => { nested ??= findDirectSecret(value); });
  return nested;
}

export function containsSecret(text: string): boolean {
  return findSecret(text) !== null;
}

function redactDirectSecrets(text: string): string {
  let redacted = text;
  const structuredSpans = findStructuredSecretSpans(redacted)
    .filter((span) => !looksLikePlaceholder(span.value))
    .sort((a, b) => b.start - a.start);
  for (const span of structuredSpans) {
    const raw = redacted.slice(span.start, span.end);
    const quote = raw[0];
    let replacement = "[REDACTED_STRUCTURED_SECRET_ASSIGNMENT]";
    if ((quote === '"' || quote === "'" || quote === "`") && raw.at(-1) === quote) {
      replacement = `${quote}${replacement}${quote}`;
    } else {
      const block = /^(?<marker>[>|](?:(?:[+-]\d?)|(?:\d[+-]?))?)(?<header>[^\r\n]*)(?<newline>\r?\n)(?<indent>[ \t]*)/.exec(raw);
      if (block?.groups) {
        const trailingNewline = /\r?\n$/.exec(raw)?.[0] ?? "";
        replacement = `${block.groups.marker}${block.groups.header}${block.groups.newline}${block.groups.indent}${replacement}${trailingNewline}`;
      } else {
        replacement += /\r?\n$/.exec(raw)?.[0] ?? "";
      }
    }
    redacted = `${redacted.slice(0, span.start)}${replacement}${redacted.slice(span.end)}`;
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    redacted = redacted.replace(pattern.re, (...args: unknown[]) => {
      const whole = typeof args[0] === "string" ? args[0] : "";
      const value = pattern.valueIndex && typeof args[pattern.valueIndex] === "string"
        ? args[pattern.valueIndex] as string
        : whole;
      // Structured redaction runs first. Do not let a later assignment regex
      // consume the opening portion of its sentinel and append another `]`.
      if (whole.includes("[REDACTED_")) return whole;
      return value && looksLikePlaceholder(value)
        ? whole
        : `[REDACTED_${pattern.name.toUpperCase().replace(/-/g, "_")}]`;
    });
    pattern.re.lastIndex = 0;
  }
  return redacted;
}

export function redactKnownSecrets(text: string): string {
  const parsed = parseJsonContainer(text);
  const nestedRedacted = parsed == null
    ? text
    : JSON.stringify(mapJsonStrings(parsed, redactDirectSecrets));
  return redactDirectSecrets(nestedRedacted);
}
