import { join } from "node:path";
import {
  appendPrivateFile,
  enforcePrivatePath,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFileAtomic,
  writePrivateFileExclusive,
} from "./file-privacy.js";
import {
  normalizeSelfImprovementBody,
  normalizeSelfImprovementLabel,
  normalizeSelfImprovementSummary,
} from "./self-improvement-content-policy.js";

export const DEFAULT_LEARNINGS_TEMPLATE = `# Learnings

Append structured entries:
- LRN-YYYYMMDD-XXX for corrections / best practices / knowledge gaps
- Include summary, details, suggested action, metadata, and status`;

export const DEFAULT_ERRORS_TEMPLATE = `# Errors

Append structured entries:
- ERR-YYYYMMDD-XXX for command/tool/integration failures
- Include symptom, context, probable cause, and prevention`;

const fileWriteQueues = new Map<string, Promise<void>>();

async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  fileWriteQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  }
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function nextLearningId(filePath: string, prefix: "LRN" | "ERR"): Promise<string> {
  const date = todayYmd();
  const content = await readPrivateFile(filePath);
  const matches = content.match(new RegExp(`\\[${prefix}-${date}-\\d{3}\\]`, "g"));
  const count = matches?.length ?? 0;
  return `${prefix}-${date}-${String(count + 1).padStart(3, "0")}`;
}

export async function ensureSelfImprovementLearningFiles(baseDir: string): Promise<void> {
  const learningsDir = join(baseDir, ".learnings");
  ensurePrivateDirectory(learningsDir);

  const ensureFile = async (filePath: string, content: string) => {
    try {
      enforcePrivatePath(filePath, { kind: "file" });
      const existing = await readPrivateFile(filePath);
      if (existing.trim().length > 0) return;
      await writePrivateFileAtomic(filePath, `${content.trim()}\n`);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await writePrivateFileExclusive(filePath, `${content.trim()}\n`);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      enforcePrivatePath(filePath, { kind: "file" });
      if (!(await readPrivateFile(filePath)).trim()) {
        await writePrivateFileAtomic(filePath, `${content.trim()}\n`);
      }
    }
  };

  await ensureFile(join(learningsDir, "LEARNINGS.md"), DEFAULT_LEARNINGS_TEMPLATE);
  await ensureFile(join(learningsDir, "ERRORS.md"), DEFAULT_ERRORS_TEMPLATE);
}

export interface AppendSelfImprovementEntryParams {
  baseDir: string;
  type: "learning" | "error";
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
}

export async function appendSelfImprovementEntry(params: AppendSelfImprovementEntryParams): Promise<{
  id: string;
  filePath: string;
}> {
  const {
    baseDir,
    type,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    status = "pending",
    source = "clawlore/self_improvement_log",
  } = params;

  await ensureSelfImprovementLearningFiles(baseDir);
  const learningsDir = join(baseDir, ".learnings");
  const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
  const filePath = join(learningsDir, fileName);
  const idPrefix = type === "learning" ? "LRN" : "ERR";

  const id = await withFileWriteQueue(filePath, async () => {
    const entryId = await nextLearningId(filePath, idPrefix);
    const nowIso = new Date().toISOString();
    const safeCategory = normalizeSelfImprovementLabel(category, "learning category", "best_practice");
    const safeArea = normalizeSelfImprovementLabel(area, "learning area", "config");
    const safePriority = normalizeSelfImprovementLabel(priority, "learning priority", "medium");
    const safeStatus = normalizeSelfImprovementLabel(status, "learning status", "pending");
    const titleSuffix = type === "learning" ? ` ${safeCategory}` : "";
    const entry = [
      `## [${entryId}]${titleSuffix}`,
      "",
      `**Logged**: ${nowIso}`,
      `**Priority**: ${safePriority}`,
      `**Status**: ${safeStatus}`,
      `**Area**: ${safeArea}`,
      "",
      "### Summary",
      normalizeSelfImprovementSummary(summary),
      "",
      "### Details",
      normalizeSelfImprovementBody(details, "learning details", 16_000),
      "",
      "### Suggested Action",
      normalizeSelfImprovementBody(suggestedAction, "learning suggested action", 8_000),
      "",
      "### Metadata",
      `- Source: ${normalizeSelfImprovementLabel(source, "learning source", "clawlore/self_improvement_log")}`,
      "---",
      "",
    ].join("\n");
    const prev = await readPrivateFile(filePath);
    const separator = prev.trimEnd().length > 0 ? "\n\n" : "";
    await appendPrivateFile(filePath, `${separator}${entry}`);
    return entryId;
  });

  return { id, filePath };
}
