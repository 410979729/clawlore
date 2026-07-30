import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { digestSourceIdentifier, requireDigestBoundaryIdentifier, } from "../../digest-boundary-policy.js";
import { verifyPrivatePath } from "../../file-privacy.js";
const require = createRequire(import.meta.url);
const REQUIRED_SESSION_COLUMNS = new Set(["session_id"]);
const REQUIRED_EVENT_COLUMNS = new Set(["session_id", "seq", "event_json", "created_at"]);
const SESSION_CATALOG_TABLES = ["sessions", "session_windows"];
const SAFE_ROLES = new Set(["user", "assistant"]);
const SAFE_TEXT_TYPES = new Set(["text", "output_text"]);
const TOOL_CALL_TYPES = new Set(["toolCall", "tool_call"]);
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;
function boundedInteger(value, label, fallback) {
    const resolved = value == null ? fallback : Number(value);
    if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return Number(resolved);
}
function requiredColumns(db, table, expected) {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
    const actual = new Set(rows.map((row) => String(row.name || "")));
    const missing = [...expected].filter((column) => !actual.has(column));
    if (missing.length > 0) {
        throw new Error(`unsupported OpenClaw transcript schema: ${table} missing ${missing.join(",")}`);
    }
}
function tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function resolveSessionCatalogTable(db) {
    for (const table of SESSION_CATALOG_TABLES) {
        if (!tableExists(db, table))
            continue;
        requiredColumns(db, table, REQUIRED_SESSION_COLUMNS);
        return table;
    }
    throw new Error("unsupported OpenClaw transcript schema: missing sessions or session_windows");
}
function enforcePrivateDatabaseFile(path, label) {
    if (!existsSync(path))
        return;
    if (lstatSync(path).isSymbolicLink())
        throw new Error(`${label} must not be a symbolic link`);
    const info = statSync(path);
    if (!info.isFile())
        throw new Error(`${label} must be a regular file`);
    try {
        verifyPrivatePath(path, { kind: "file" });
    }
    catch (error) {
        throw new Error(`${label} must be owner-only`, { cause: error });
    }
}
function canonicalPrivateDatabasePath(dbPath) {
    if (!dbPath.trim())
        throw new Error("transcript database path is required");
    const requested = resolve(dbPath.trim());
    enforcePrivateDatabaseFile(requested, "transcript database");
    const canonical = realpathSync(requested);
    for (const [suffix, label] of [
        ["", "transcript database"],
        ["-wal", "transcript WAL"],
        ["-shm", "transcript shared-memory file"],
    ])
        enforcePrivateDatabaseFile(`${canonical}${suffix}`, label);
    return canonical;
}
function safeMessagePayload(rawEvent) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent))
        return null;
    const event = rawEvent;
    if (event.type !== "message" || !event.message || typeof event.message !== "object"
        || Array.isArray(event.message))
        return null;
    const message = event.message;
    const role = String(message.role || "");
    if (!SAFE_ROLES.has(role))
        return null;
    const texts = [];
    const toolNames = new Set();
    const content = message.content;
    if (typeof content === "string" && content.trim()) {
        texts.push(content.trim());
    }
    else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === "string") {
                if (part.trim())
                    texts.push(part.trim());
                continue;
            }
            if (!part || typeof part !== "object" || Array.isArray(part))
                continue;
            const item = part;
            const type = String(item.type || "");
            if (SAFE_TEXT_TYPES.has(type)) {
                const text = String(item.text || "").trim();
                if (text && !text.slice(0, 300).includes("plugin-injected system context")) {
                    texts.push(text);
                }
            }
            else if (role === "assistant" && TOOL_CALL_TYPES.has(type)) {
                const name = String(item.name || item.toolName || "").trim();
                if (SAFE_TOOL_NAME.test(name))
                    toolNames.add(name);
            }
        }
    }
    const text = texts.join("\n").trim().slice(0, 20_000);
    if (!text && toolNames.size === 0)
        return null;
    return {
        role: role,
        text,
        toolNames: [...toolNames].sort(),
    };
}
function transcriptProvenanceId(sessionId, seq) {
    const digest = createHash("sha256")
        .update(`${sessionId}:${seq}`, "utf8")
        .digest("hex")
        .slice(0, 20);
    return digestSourceIdentifier(`openclaw-transcript-sha256-${digest}`, "openclaw-transcript");
}
function chunkText(payload) {
    const role = payload.role === "user" ? "User message" : "Assistant message";
    const toolLine = payload.toolNames.length > 0
        ? `Assistant tool names: ${payload.toolNames.join(", ")}`
        : "";
    return [payload.text ? `${role}:\n${payload.text}` : "", toolLine]
        .filter(Boolean)
        .join("\n")
        .trim();
}
/**
 * Read one exact OpenClaw session from the host transcript database. The
 * connection is opened read-only and query-only. Raw session identifiers,
 * tool arguments/results, thinking, and custom events never enter a chunk.
 */
export function readOpenClawSqliteTranscript(options) {
    const canonical = canonicalPrivateDatabasePath(options.dbPath);
    const sessionId = requireDigestBoundaryIdentifier(options.sessionId, "transcript session id", "");
    const scope = requireDigestBoundaryIdentifier(options.scope, "digest scope", "");
    const startMs = options.startMs == null
        ? undefined
        : boundedInteger(options.startMs, "transcript startMs");
    const endMs = options.endMs == null
        ? undefined
        : boundedInteger(options.endMs, "transcript endMs");
    if (startMs != null && endMs != null && startMs >= endMs) {
        throw new Error("transcript startMs must be lower than endMs");
    }
    const maxEvents = Math.min(200, Math.max(1, boundedInteger(options.maxEvents, "transcript maxEvents", 25)));
    const scanLimit = Math.min(4_000, maxEvents * 20);
    const { DatabaseSync: Sqlite } = require("node:sqlite");
    const db = new Sqlite(canonical, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
        const sessionCatalogTable = resolveSessionCatalogTable(db);
        requiredColumns(db, "transcript_events", REQUIRED_EVENT_COLUMNS);
        const predicates = ["s.session_id = ?"];
        const parameters = [sessionId];
        if (startMs != null) {
            predicates.push("t.created_at >= ?");
            parameters.push(startMs);
        }
        if (endMs != null) {
            predicates.push("t.created_at < ?");
            parameters.push(endMs);
        }
        parameters.push(scanLimit);
        const rows = db.prepare(`
      SELECT t.session_id, t.seq, t.event_json, t.created_at
      FROM transcript_events AS t
      JOIN ${sessionCatalogTable} AS s ON s.session_id = t.session_id
      WHERE ${predicates.join(" AND ")}
      ORDER BY t.created_at DESC, t.seq DESC
      LIMIT ?
    `).all(...parameters);
        const chunks = [];
        for (const row of rows) {
            let event;
            try {
                event = JSON.parse(String(row.event_json));
            }
            catch {
                continue;
            }
            const payload = safeMessagePayload(event);
            if (!payload)
                continue;
            const seq = boundedInteger(row.seq, "transcript sequence");
            const sourceId = transcriptProvenanceId(String(row.session_id), seq);
            chunks.push({
                id: `chunk-${sourceId}`,
                source_type: "openclaw_sqlite_transcript",
                source_id: sourceId,
                scope,
                text: chunkText(payload),
            });
            if (chunks.length >= maxEvents)
                break;
        }
        chunks.reverse();
        if (chunks.length === 0) {
            throw new Error("no eligible transcript events found for the exact session and window");
        }
        return {
            chunks,
            inspection: {
                schemaVersion: 1,
                source: "openclaw-agent-sqlite",
                sourceType: "openclaw_sqlite_transcript",
                readOnly: true,
                exactSession: true,
                scannedEvents: rows.length,
                eligibleEvents: chunks.length,
                toolResultBodiesEligible: false,
                toolArgumentsEligible: false,
                thinkingEligible: false,
            },
        };
    }
    finally {
        db.close();
    }
}
