import { randomUUID } from "node:crypto";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { isNoise } from "./noise-filter.js";
import type { LlmClient } from "./llm-client.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";

type DatabaseSync = any;

export type DigestRunStatus =
  | "ok"
  | "ok_with_fallback"
  | "empty"
  | "filtered"
  | "parse_error"
  | "retry_exhausted"
  | "dead_letter";

export type DigestChunkStatus =
  | "candidate"
  | "empty"
  | "filtered"
  | "parse_error"
  | "retry_exhausted"
  | "dead_letter"
  | "pending_recovery"
  | "recovered";

export type DigestMemoryType =
  | "workflow"
  | "pitfall"
  | "decision"
  | "preference"
  | "project"
  | "resource"
  | "case";

export interface DigestCandidate {
  memory_type: DigestMemoryType;
  category: MemoryEntry["category"];
  abstract: string;
  overview: string;
  content: string;
  confidence: number;
  importance: number;
  evidence: string;
}

export interface DigestInputChunk {
  id: string;
  source_type: "explicit" | "reflection_event" | "memory_truth";
  source_id: string;
  scope: string;
  text: string;
}

export interface DigestRunOptions {
  apply?: boolean;
  scope?: string;
  inputText?: string;
  sourceId?: string;
  sourceType?: DigestInputChunk["source_type"];
  maxChunks?: number;
  useLlm?: boolean;
  llmFallback?: boolean;
  actor?: string;
  store?: MemoryStore;
  embedPassage?: (text: string) => Promise<number[]>;
  llmClient?: LlmClient;
}

export interface DigestRunResult {
  ok: boolean;
  status: DigestRunStatus;
  dry_run: boolean;
  run_id: string;
  source: {
    chunks_seen: number;
    chunks_used: number;
    source_type: string;
  };
  extracted: number;
  stored: number;
  skipped: number;
  errors: string[];
  candidates: Array<DigestCandidate & { chunk_id: string; stored_id?: string }>;
}

type DigestRunRow = {
  id: string;
  run_date: string;
  started_at: string;
  completed_at: string | null;
  status: DigestRunStatus;
  source_type: string;
  source_count: number;
  chunk_count: number;
  candidate_count: number;
  stored_count: number;
  skipped_count: number;
  error_count: number;
  notes: string;
  actor: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function nowRunDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function cleanText(value: string): string {
  return sanitizeCaptureText(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function previewFor(value: string): string {
  return cleanText(value)
    .replace(/\/home\/[^\s"',;)}\]]+/g, "[redacted:path]")
    .replace(/\/Users\/[^\s"',;)}\]]+/g, "[redacted:path]")
    .replace(/[A-Z]:\\[^\s"',;)}\]]+/g, "[redacted:path]")
    .slice(0, 220);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function safeParseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?").get(name));
}

function groupedCounts(db: DatabaseSync, sql: string): Record<string, number> {
  const rows = db.prepare(sql).all() as Array<{ key?: unknown; count?: unknown }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row.key ?? "unknown");
    result[key] = Number(row.count || 0);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function ensureDigestSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS openclaw_digest_runs (
      id TEXT PRIMARY KEY,
      run_date TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      stored_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT 'clawlore'
    );

    CREATE TABLE IF NOT EXISTS openclaw_digest_chunks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      candidate_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES openclaw_digest_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_openclaw_digest_runs_started
      ON openclaw_digest_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_openclaw_digest_runs_status
      ON openclaw_digest_runs(status);
    CREATE INDEX IF NOT EXISTS idx_openclaw_digest_chunks_run
      ON openclaw_digest_chunks(run_id);
    CREATE INDEX IF NOT EXISTS idx_openclaw_digest_chunks_status
      ON openclaw_digest_chunks(status);
  `);
}

function explicitChunk(params: {
  text: string;
  scope: string;
  sourceId?: string;
  sourceType?: DigestInputChunk["source_type"];
}): DigestInputChunk {
  return {
    id: `chunk-${randomUUID()}`,
    source_type: params.sourceType || "explicit",
    source_id: params.sourceId || "explicit-input",
    scope: params.scope,
    text: params.text,
  };
}

function collectReflectionChunks(db: DatabaseSync, scope: string, maxChunks: number): DigestInputChunk[] {
  if (!tableExists(db, "memory_truth")) return [];
  const rows = db.prepare(`
    SELECT id, text, scope, metadata, updated_at, timestamp
    FROM memory_truth
    WHERE scope = ?
      AND (
        category = 'reflection'
        OR (
        json_valid(metadata)
        AND COALESCE(json_extract(metadata, '$.type'), '') = 'memory-reflection-event'
        )
      )
    ORDER BY updated_at DESC, timestamp DESC
    LIMIT ?
  `).all(scope, Math.max(1, Math.min(200, maxChunks))) as Array<{
    id: string;
    text: string;
    scope: string;
    metadata: string;
  }>;

  return rows.map((row) => {
    const metadata = safeParseJsonObject(row.metadata);
    const sourceId =
      typeof metadata.eventId === "string" && metadata.eventId.trim()
        ? metadata.eventId.trim()
        : row.id;
    return {
      id: `chunk-${row.id}`,
      source_type: "reflection_event",
      source_id: sourceId,
      scope: row.scope || scope,
      text: row.text || "",
    };
  });
}

export function collectDigestChunks(db: DatabaseSync, options: DigestRunOptions = {}): DigestInputChunk[] {
  const scope = options.scope || "agent:main";
  const maxChunks = Math.max(1, Math.min(200, Math.trunc(options.maxChunks ?? 25)));
  if (typeof options.inputText === "string" && options.inputText.trim()) {
    return [explicitChunk({
      text: options.inputText,
      scope,
      sourceId: options.sourceId,
      sourceType: options.sourceType,
    })];
  }
  return collectReflectionChunks(db, scope, maxChunks);
}

function memoryCategoryFor(type: DigestMemoryType): MemoryEntry["category"] {
  switch (type) {
    case "decision":
      return "decision";
    case "preference":
      return "preference";
    case "project":
    case "resource":
      return "fact";
    case "pitfall":
    case "workflow":
    case "case":
    default:
      return "other";
  }
}

function normalizeMemoryType(raw: unknown): DigestMemoryType | null {
  const value = String(raw || "").toLowerCase().trim();
  switch (value) {
    case "workflow":
    case "pitfall":
    case "decision":
    case "preference":
    case "project":
    case "resource":
    case "case":
      return value;
    default:
      return null;
  }
}

function normalizeCandidate(raw: unknown, fallbackEvidence: string): DigestCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const memoryType = normalizeMemoryType(obj.memory_type || obj.memoryType || obj.type);
  const abstract = cleanText(String(obj.abstract || obj.summary || ""));
  const overview = cleanText(String(obj.overview || obj.title || abstract));
  const content = cleanText(String(obj.content || obj.details || ""));
  if (!memoryType || abstract.length < 12 || content.length < 20) return null;
  const candidate: DigestCandidate = {
    memory_type: memoryType,
    category: memoryCategoryFor(memoryType),
    abstract: abstract.slice(0, 280),
    overview: overview.slice(0, 800),
    content: content.slice(0, 2400),
    confidence: clamp01(obj.confidence, 0.68),
    importance: clamp01(obj.importance, 0.62),
    evidence: cleanText(String(obj.evidence || fallbackEvidence)).slice(0, 500),
  };
  return candidate;
}

function classifyHeuristic(text: string): DigestMemoryType | null {
  const lowered = text.toLowerCase();
  if (/(坑|报错|失败|错误|回归|pitfall|bug|failed|error|regression)/i.test(text)) return "pitfall";
  if (/(流程|步骤|sop|playbook|workflow|run .*verify|verify .*run|release gate)/i.test(text)) return "workflow";
  if (/(决定|决策|必须|禁止|不能|should|must|decision|decided)/i.test(text)) return "decision";
  if (/(偏好|喜欢|希望|preference|prefer)/i.test(text)) return "preference";
  if (/(项目|工程|plugin|gateway|openclaw|clawlore|scope-recall)/i.test(text)) return "project";
  if (/https?:\/\/|path:|文件|文档|resource/i.test(text)) return "resource";
  if (lowered.includes("case") || lowered.includes("事故") || lowered.includes("复盘")) return "case";
  return null;
}

function heuristicCandidate(chunk: DigestInputChunk): DigestCandidate | null {
  const cleaned = cleanText(chunk.text);
  if (cleaned.length < 40) return null;
  const memoryType = classifyHeuristic(cleaned);
  if (!memoryType) return null;
  const firstSentence = cleaned.split(/[。！？!?]\s*|\.\s+/).find((part) => part.trim().length >= 12)?.trim() || cleaned;
  const abstract = firstSentence.slice(0, 220);
  const overview = `${memoryType}: ${abstract}`;
  const content = cleaned.slice(0, 1600);
  return {
    memory_type: memoryType,
    category: memoryCategoryFor(memoryType),
    abstract,
    overview,
    content,
    confidence: memoryType === "decision" || memoryType === "workflow" ? 0.74 : 0.66,
    importance: memoryType === "decision" || memoryType === "pitfall" ? 0.72 : 0.64,
    evidence: previewFor(cleaned),
  };
}

async function llmCandidates(
  chunk: DigestInputChunk,
  llmClient: LlmClient,
): Promise<DigestCandidate[]> {
  const prompt = `Extract durable memory candidates from this OpenClaw session digest chunk.

Rules:
- Return JSON only: {"candidates":[...]}.
- Do not extract raw transcript summaries.
- Only include durable workflows, pitfalls, decisions, preferences, projects, resources, or cases.
- Each candidate must include memory_type, abstract, overview, content, confidence, importance, evidence.
- confidence and importance are numbers from 0 to 1.
- If nothing durable is present, return {"candidates":[]}.

Chunk:
${chunk.text.slice(0, 5000)}`;

  const response = await llmClient.completeJson<{ candidates?: unknown[] }>(prompt, "digest-extraction");
  const rawCandidates = Array.isArray(response?.candidates) ? response.candidates : [];
  return rawCandidates
    .map((item) => normalizeCandidate(item, chunk.text))
    .filter((item): item is DigestCandidate => Boolean(item));
}

function candidateToEntry(
  candidate: DigestCandidate,
  chunk: DigestInputChunk,
  vector: number[],
): Omit<MemoryEntry, "id" | "timestamp"> {
  const text = [
    candidate.abstract,
    "",
    candidate.overview,
    "",
    candidate.content,
  ].join("\n").trim();
  const at = nowIso();
  const metadata = {
    source: "openclaw-native-digest",
    source_type: chunk.source_type,
    source_id: chunk.source_id,
    digest_schema: "openclaw-digest-v1",
    digest_chunk_id: chunk.id,
    memory_type: candidate.memory_type,
    memory_layer: "digest-candidate",
    lifecycle: "candidate",
    state: "pending",
    confidence: candidate.confidence,
    source_confidence: candidate.confidence,
    importance: candidate.importance,
    freshness_status: "unknown",
    live_check_needed: false,
    observed_at: at,
    evidence: candidate.evidence,
    l0_abstract: candidate.abstract,
    l1_overview: candidate.overview,
    l2_content: candidate.content,
  };
  return {
    text,
    vector,
    category: candidate.category,
    scope: chunk.scope || "agent:main",
    importance: candidate.importance,
    metadata: safeJson(metadata),
  };
}

function insertRun(db: DatabaseSync, row: DigestRunRow): void {
  ensureDigestSchema(db);
  db.prepare(`
    INSERT INTO openclaw_digest_runs (
      id, run_date, started_at, completed_at, status, source_type,
      source_count, chunk_count, candidate_count, stored_count, skipped_count,
      error_count, notes, actor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.run_date,
    row.started_at,
    row.completed_at,
    row.status,
    row.source_type,
    row.source_count,
    row.chunk_count,
    row.candidate_count,
    row.stored_count,
    row.skipped_count,
    row.error_count,
    row.notes,
    row.actor,
  );
}

function updateRun(db: DatabaseSync, row: DigestRunRow): void {
  db.prepare(`
    UPDATE openclaw_digest_runs
    SET completed_at = ?, status = ?, chunk_count = ?, candidate_count = ?,
        stored_count = ?, skipped_count = ?, error_count = ?, notes = ?
    WHERE id = ?
  `).run(
    row.completed_at,
    row.status,
    row.chunk_count,
    row.candidate_count,
    row.stored_count,
    row.skipped_count,
    row.error_count,
    row.notes,
    row.id,
  );
}

function insertChunkEvent(
  db: DatabaseSync,
  params: {
    id: string;
    runId: string;
    chunk: DigestInputChunk;
    status: DigestChunkStatus;
    reason: string;
    candidateIds?: string[];
  },
): void {
  db.prepare(`
    INSERT INTO openclaw_digest_chunks (
      id, run_id, source_type, source_id, scope, status, reason,
      preview, candidate_ids, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.runId,
    params.chunk.source_type,
    params.chunk.source_id,
    params.chunk.scope || "agent:main",
    params.status,
    params.reason,
    previewFor(params.chunk.text),
    safeJson(params.candidateIds || []),
    nowIso(),
  );
}

function runStatusFrom(params: {
  chunkCount: number;
  candidateCount: number;
  storedCount: number;
  skipped: number;
  errors: string[];
  usedFallback: boolean;
  llmParseErrors: number;
}): DigestRunStatus {
  if (params.chunkCount === 0) return "empty";
  if (params.llmParseErrors > 0 && params.candidateCount === 0 && params.errors.length > 0) return "parse_error";
  if (params.candidateCount === 0 && params.skipped > 0) return "filtered";
  if (params.errors.length > 0 && params.candidateCount === 0) return "retry_exhausted";
  if (params.usedFallback) return "ok_with_fallback";
  return "ok";
}

function validateCandidate(candidate: DigestCandidate): { ok: boolean; reason?: string } {
  const safety = evaluateCaptureSafety(`${candidate.abstract}\n${candidate.overview}\n${candidate.content}`);
  if (!safety.allowed) return { ok: false, reason: safety.reason || "capture_safety" };
  if (isNoise(candidate.content) || isNoise(candidate.abstract)) return { ok: false, reason: "noise_filter" };
  if (candidate.content.length < 20 || candidate.abstract.length < 12) return { ok: false, reason: "too_short" };
  return { ok: true };
}

export async function runDigestPipeline(
  db: DatabaseSync,
  options: DigestRunOptions = {},
): Promise<DigestRunResult> {
  const dryRun = options.apply !== true;
  const chunks = collectDigestChunks(db, options);
  const runId = `digest-${randomUUID()}`;
  const startedAt = nowIso();
  const actor = options.actor || "clawlore:cli";
  const sourceType = chunks[0]?.source_type || options.sourceType || "reflection_event";
  const runRow: DigestRunRow = {
    id: runId,
    run_date: nowRunDate(),
    started_at: startedAt,
    completed_at: null,
    status: "empty",
    source_type: sourceType,
    source_count: chunks.length,
    chunk_count: 0,
    candidate_count: 0,
    stored_count: 0,
    skipped_count: 0,
    error_count: 0,
    notes: "{}",
    actor,
  };

  if (!dryRun) {
    insertRun(db, runRow);
  }

  const candidates: DigestRunResult["candidates"] = [];
  const errors: string[] = [];
  let skipped = 0;
  let stored = 0;
  let usedFallback = false;
  let llmParseErrors = 0;

  for (const chunk of chunks) {
    const safety = evaluateCaptureSafety(chunk.text);
    if (!safety.allowed) {
      skipped += 1;
      if (!dryRun) {
        insertChunkEvent(db, {
          id: `digest-chunk-${randomUUID()}`,
          runId,
          chunk,
          status: "filtered",
          reason: safety.reason || "capture_safety",
        });
      }
      continue;
    }

    const cleaned = cleanText(chunk.text);
    if (cleaned.length < 40 || isNoise(cleaned)) {
      skipped += 1;
      if (!dryRun) {
        insertChunkEvent(db, {
          id: `digest-chunk-${randomUUID()}`,
          runId,
          chunk,
          status: "empty",
          reason: "empty_or_noise",
        });
      }
      continue;
    }

    let chunkCandidates: DigestCandidate[] = [];
    if (options.useLlm === true && options.llmClient) {
      try {
        chunkCandidates = await llmCandidates(chunk, options.llmClient);
      } catch (err) {
        llmParseErrors += 1;
        errors.push(`llm_parse_error:${diagnosticErrorSummary(err)}`);
      }
    }

    if (chunkCandidates.length === 0 && options.llmFallback !== false) {
      const fallback = heuristicCandidate({ ...chunk, text: cleaned });
      if (fallback) {
        usedFallback = true;
        chunkCandidates = [fallback];
      }
    }

    const validCandidates = chunkCandidates.filter((candidate) => {
      const validation = validateCandidate(candidate);
      if (!validation.ok) {
        skipped += 1;
        return false;
      }
      return true;
    });

    if (validCandidates.length === 0) {
      skipped += 1;
      if (!dryRun) {
        insertChunkEvent(db, {
          id: `digest-chunk-${randomUUID()}`,
          runId,
          chunk,
          status: llmParseErrors > 0 ? "parse_error" : "filtered",
          reason: llmParseErrors > 0 ? "llm_parse_error" : "no_valid_candidates",
        });
      }
      continue;
    }

    const storedIds: string[] = [];
    for (const candidate of validCandidates) {
      let storedId: string | undefined;
      if (!dryRun) {
        if (!options.store || !options.embedPassage) {
          errors.push("store_or_embedder_unavailable");
          continue;
        }
        const text = `${candidate.abstract}\n${candidate.overview}\n${candidate.content}`.trim();
        const vector = await options.embedPassage(text);
        const entry = await options.store.store(candidateToEntry(candidate, chunk, vector));
        storedId = entry.id;
        storedIds.push(entry.id);
        stored += 1;
      }
      candidates.push({ ...candidate, chunk_id: chunk.id, ...(storedId ? { stored_id: storedId } : {}) });
    }

    if (!dryRun) {
      insertChunkEvent(db, {
        id: `digest-chunk-${randomUUID()}`,
        runId,
        chunk,
        status: storedIds.length > 0 || dryRun ? "candidate" : "retry_exhausted",
        reason: storedIds.length > 0 ? "candidate_only" : "store_failed",
        candidateIds: storedIds,
      });
    }
  }

  const status = runStatusFrom({
    chunkCount: chunks.length,
    candidateCount: candidates.length,
    storedCount: stored,
    skipped,
    errors,
    usedFallback,
    llmParseErrors,
  });

  const result: DigestRunResult = {
    ok: ["ok", "ok_with_fallback", "empty", "filtered"].includes(status) && errors.length === 0,
    status,
    dry_run: dryRun,
    run_id: runId,
    source: {
      chunks_seen: chunks.length,
      chunks_used: chunks.length - skipped,
      source_type: sourceType,
    },
    extracted: candidates.length,
    stored,
    skipped,
    errors,
    candidates,
  };

  if (!dryRun) {
    runRow.completed_at = nowIso();
    runRow.status = status;
    runRow.chunk_count = chunks.length;
    runRow.candidate_count = candidates.length;
    runRow.stored_count = stored;
    runRow.skipped_count = skipped;
    runRow.error_count = errors.length;
    runRow.notes = safeJson({
      dry_run: false,
      used_fallback: usedFallback,
      llm_parse_errors: llmParseErrors,
      errors: errors.slice(0, 10),
    });
    updateRun(db, runRow);
  }

  return result;
}

export function digestReport(db: DatabaseSync, options: { sampleLimit?: number } = {}): Record<string, unknown> {
  if (!tableExists(db, "openclaw_digest_runs")) {
    return {
      enabled: true,
      status: "not_initialized",
      message: "OpenClaw-native digest ledger has not been initialized.",
    };
  }
  const sampleLimit = Math.max(0, Math.min(25, Math.trunc(options.sampleLimit ?? 8)));
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM openclaw_digest_runs").get()?.count || 0);
  const lastRun = db.prepare("SELECT * FROM openclaw_digest_runs ORDER BY started_at DESC LIMIT 1").get() || {};
  const candidateRows = tableExists(db, "memory_truth")
    ? Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM memory_truth
        WHERE json_valid(metadata)
          AND COALESCE(json_extract(metadata, '$.source'), '') = 'openclaw-native-digest'
          AND COALESCE(json_extract(metadata, '$.lifecycle'), '') = 'candidate'
      `).get()?.count || 0)
    : 0;
  const samples = sampleLimit > 0 && tableExists(db, "openclaw_digest_chunks")
    ? db.prepare(`
        SELECT run_id, source_type, source_id, scope, status, reason, preview, candidate_ids, created_at
        FROM openclaw_digest_chunks
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sampleLimit)
    : [];
  const failedStatuses = ["parse_error", "retry_exhausted", "dead_letter"];
  const failed = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM openclaw_digest_runs
    WHERE status IN ('parse_error', 'retry_exhausted', 'dead_letter')
  `).get()?.count || 0);
  return {
    enabled: true,
    status: failed > 0 ? "needs_recovery" : "ready",
    runs: {
      total,
      byStatus: groupedCounts(db, "SELECT status AS key, COUNT(*) AS count FROM openclaw_digest_runs GROUP BY status"),
    },
    chunks: tableExists(db, "openclaw_digest_chunks")
      ? {
          byStatus: groupedCounts(db, "SELECT status AS key, COUNT(*) AS count FROM openclaw_digest_chunks GROUP BY status"),
          failed: Number(db.prepare(`
            SELECT COUNT(*) AS count FROM openclaw_digest_chunks
            WHERE status IN ('parse_error', 'retry_exhausted', 'dead_letter')
          `).get()?.count || 0),
        }
      : { byStatus: {}, failed: 0 },
    candidate_debt: candidateRows,
    failed_runs: failed,
    recoverable_statuses: failedStatuses,
    lastRun,
    samples,
  };
}

export function digestRecoveryReport(db: DatabaseSync, options: { limit?: number } = {}): Record<string, unknown> {
  if (!tableExists(db, "openclaw_digest_chunks")) {
    return { status: "not_initialized", candidate_count: 0, candidates: [] };
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const rows = db.prepare(`
    SELECT id, run_id, source_type, source_id, scope, status, reason, preview, created_at
    FROM openclaw_digest_chunks
    WHERE status IN ('parse_error', 'retry_exhausted', 'dead_letter')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
  return {
    status: rows.length > 0 ? "needs_recovery" : "ready",
    candidate_count: rows.length,
    limit,
    candidates: rows,
  };
}

export function recoverDigestChunks(
  db: DatabaseSync,
  options: { dryRun?: boolean; limit?: number; actor?: string } = {},
): Record<string, unknown> {
  const dryRun = options.dryRun !== false;
  const report = digestRecoveryReport(db, { limit: options.limit });
  const rows = (report.candidates || []) as Array<{ id: string; status: string }>;
  if (dryRun || rows.length === 0) {
    return { ...report, dry_run: dryRun, recovered: 0 };
  }
  const at = nowIso();
  for (const row of rows) {
    db.prepare(`
      UPDATE openclaw_digest_chunks
      SET status = 'pending_recovery',
          reason = reason || '; recovery_requested_by:${options.actor || "clawlore:cli"} @ ${at}'
      WHERE id = ?
        AND status IN ('parse_error', 'retry_exhausted', 'dead_letter')
    `).run(row.id);
  }
  return {
    status: "recovery_scheduled",
    dry_run: false,
    recovered: rows.length,
    candidates: rows,
  };
}
