import { readFile, readdir, stat } from "node:fs/promises";
import { relative } from "node:path";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const CONTENT_RULES = [
  { id: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: "openai-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: "telegram-bot-token", regex: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g },
  { id: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}\b/gi },
  {
    id: "credential-assignment",
    regex: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b\s*[:=]\s*["']?([A-Za-z0-9._~+\/-]{12,}={0,2})/gi,
    capture: 1,
  },
  { id: "host-user-path", regex: /(?:\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\)/g },
];

function isPlaceholder(value) {
  const lower = String(value).toLowerCase();
  return (
    /[<$\[{]/.test(value)
    || /^(?:example|invalid|placeholder|redacted|dummy|fake|test|canary|changeme|xxx)(?:[-_:/].*)?$/.test(lower)
    || /^(?:your[-_]).+/.test(lower)
    || /(?:^|[\\/])(?:example|test|user|username|your-name)(?:[-_][^\\/]*)?(?:[\\/]|$)/.test(lower)
  );
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return probe.includes(0);
}

function isUnquotedCodeExpression(rule, match, path) {
  if (rule.id !== "credential-assignment" || !/\.(?:[cm]?[jt]s)$/i.test(path)) return false;
  const assignment = match[0].match(/[:=]\s*(.*)$/s)?.[1] ?? "";
  return !assignment.startsWith('"') && !assignment.startsWith("'");
}

async function listFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = `${current}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await listFiles(root, path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export function scanReleaseText(text, path = "<memory>") {
  const findings = [];
  for (const rule of CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      const candidate = match[rule.capture ?? 0] || match[0];
      if (isPlaceholder(candidate)) continue;
      if (isUnquotedCodeExpression(rule, match, path)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ path, rule: rule.id, line });
    }
  }
  return findings;
}

export async function scanReleaseDirectory(root) {
  const findings = [];
  for (const file of await listFiles(root)) {
    const info = await stat(file);
    if (info.size > MAX_TEXT_FILE_BYTES) {
      findings.push({ path: relative(root, file), rule: "oversize-file-unscanned", line: 1 });
      continue;
    }
    const buffer = await readFile(file);
    if (looksBinary(buffer)) continue;
    findings.push(...scanReleaseText(buffer.toString("utf8"), relative(root, file)));
  }
  return findings;
}
