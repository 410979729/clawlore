import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stripResetSuffix } from "./session-recovery.js";
import { sanitizeCaptureText } from "./capture-safety.js";
import { redactKnownSecrets } from "./secret-redaction.js";

function extractTextContent(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).type === "text" &&
        typeof (candidate as Record<string, unknown>).text === "string",
    ) as Record<string, unknown> | undefined;
    return typeof block?.text === "string" ? block.text : null;
  }
  return null;
}

/** Excludes commands and host-injected recall blocks from durable reflection input. */
export function shouldSkipReflectionMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return true;

  if (
    role === "user" &&
    (trimmed.includes("<relevant-memories>") ||
      trimmed.includes("UNTRUSTED DATA") ||
      trimmed.includes("END UNTRUSTED DATA"))
  ) {
    return true;
  }

  return false;
}

/** Redacts common credentials, private paths, and direct identifiers before model input. */
export function redactReflectionText(text: string): string {
  const patterns: RegExp[] = [
    /\/home\/[^\s"',;)}\]]+/g,
    /\/Users\/[^\s"',;)}\]]+/g,
    /[A-Z]:\\[^\s"',;)}\]]+/g,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ];

  let redacted = redactKnownSecrets(text);
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return sanitizeCaptureText(redacted);
}

export function summarizeRecentConversationMessages(
  messages: readonly unknown[],
  messageCount: number,
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const recent: string[] = [];
  for (let index = messages.length - 1; index >= 0 && recent.length < messageCount; index--) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;

    const message = raw as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") continue;

    const text = extractTextContent(message.content);
    if (!text || shouldSkipReflectionMessage(role, text)) continue;
    recent.push(`${role}: ${redactReflectionText(text)}`);
  }

  if (recent.length === 0) return null;
  return recent.reverse().join("\n");
}

async function readSessionConversation(filePath: string, messageCount: number): Promise<string | null> {
  try {
    const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
    const messages: unknown[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "message" && entry?.message) messages.push(entry.message);
      } catch {
        // Session tails can contain a partial line after interruption; ignore it.
      }
    }
    return summarizeRecentConversationMessages(messages, messageCount);
  } catch {
    return null;
  }
}

async function sortFileNamesByMtimeDesc(dir: string, fileNames: string[]): Promise<string[]> {
  const candidates = await Promise.all(
    fileNames.map(async (name) => {
      try {
        const metadata = await stat(join(dir, name));
        return { name, mtimeMs: metadata.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  return candidates
    .filter((candidate): candidate is { name: string; mtimeMs: number } => candidate !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
    .map((candidate) => candidate.name);
}

/** Reads the active transcript, then the newest reset snapshot when the active file is unusable. */
export async function readSessionConversationWithResetFallback(
  sessionFilePath: string,
  messageCount: number,
): Promise<string | null> {
  const primary = await readSessionConversation(sessionFilePath, messageCount);
  if (primary) return primary;

  try {
    const dir = dirname(sessionFilePath);
    const resetPrefix = `${basename(sessionFilePath)}.reset.`;
    const files = await readdir(dir);
    const candidates = await sortFileNamesByMtimeDesc(
      dir,
      files.filter((name) => name.startsWith(resetPrefix)),
    );
    if (candidates.length > 0) {
      return await readSessionConversation(join(dir, candidates[0]), messageCount);
    }
  } catch {
    // Missing reset history is equivalent to an empty transcript.
  }

  return primary;
}

/** Recovers the most specific non-reset session path before considering recency fallback. */
export async function findPreviousReflectionSessionFile(
  sessionsDir: string,
  currentSessionFile?: string,
  sessionId?: string,
): Promise<string | undefined> {
  try {
    const files = await readdir(sessionsDir);
    const fileSet = new Set(files);
    const baseFromReset = currentSessionFile
      ? stripResetSuffix(basename(currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) return join(sessionsDir, baseFromReset);

    const trimmedId = sessionId?.trim();
    if (trimmedId) {
      const canonicalFile = `${trimmedId}.jsonl`;
      if (fileSet.has(canonicalFile)) return join(sessionsDir, canonicalFile);

      const topicVariants = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter(
          (name) =>
            name.startsWith(`${trimmedId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        ),
      );
      if (topicVariants.length > 0) return join(sessionsDir, topicVariants[0]);
    }

    if (currentSessionFile) {
      const nonReset = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter((name) => name.endsWith(".jsonl") && !name.includes(".reset.")),
      );
      if (nonReset.length > 0) return join(sessionsDir, nonReset[0]);
    }
  } catch {
    return undefined;
  }
}

export function sanitizeReflectionFileToken(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || fallback;
}
