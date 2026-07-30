import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  readOpenClawSqliteTranscript,
} = jiti("../src/v2/storage/openclaw-sqlite-transcript-source.ts");
const {
  enforcePrivatePath,
} = jiti("../src/file-privacy.ts");
const {
  collectDigestChunks,
  runDigestPipeline,
} = jiti("../src/digest-pipeline.ts");

function createTranscriptFixture(path, options = {}) {
  const sessionCatalog = options.sessionCatalog ?? "sessions";
  const db = new DatabaseSync(path);
  try {
    db.exec(`${sessionCatalog === "session_windows" ? `
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL
      );` : `
      CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          session_scope TEXT NOT NULL,
          chat_type TEXT,
          channel TEXT,
          primary_conversation_id TEXT
      );`}
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    if (sessionCatalog === "session_windows") {
      const insertSession = db.prepare("INSERT INTO session_windows VALUES (?, ?)");
      insertSession.run("session-1", "agent:main:telegram:direct:synthetic");
      insertSession.run("session-2", "agent:main:telegram:direct:other");
    } else {
      const insertSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)");
      insertSession.run(
        "session-1",
        "agent:main:telegram:direct:synthetic",
        "conversation",
        "direct",
        "telegram",
        "conversation-1",
      );
      insertSession.run(
        "session-2",
        "agent:main:telegram:direct:other",
        "conversation",
        "direct",
        "telegram",
        "conversation-2",
      );
    }
    const secret = "fixture-secret-must-not-escape";
    const events = [
      [1, {
        type: "message",
        message: { role: "user", content: "Decision: run the release gate before rollout." },
      }],
      [2, {
        type: "message",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: `private chain ${secret}` },
          { type: "toolCall", name: "synthetic_lookup", arguments: { token: secret } },
        ] },
      }],
      [3, {
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: secret }] },
      }],
      [4, {
        type: "message",
        message: { role: "assistant", content: [
          { type: "output_text", text: "Workflow: verify doctor after every deployment." },
        ] },
      }],
      [5, { type: "custom", payload: secret }],
    ];
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)");
    for (const [seq, event] of events) {
      insert.run("session-1", seq, JSON.stringify(event), 1_000 + seq);
    }
    insert.run("session-1", 6, "{not-json", 1_006);
    insert.run("session-2", 1, JSON.stringify({
      type: "message",
      message: { role: "user", content: `other session ${secret}` },
    }), 2_001);
  } finally {
    db.close();
  }
  enforcePrivatePath(path, { kind: "file" });
}

function createMemoryTruthDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0,
      timestamp REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      metadata_text TEXT NOT NULL DEFAULT '',
      updated_at REAL NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(
      memory_id UNINDEXED,
      text,
      metadata_text
    );
  `);
  return db;
}

test("SQLite transcript source is exact-session, content-minimal, and physically read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-transcript-source-"));
  try {
    const dbPath = join(root, "openclaw-agent.sqlite");
    createTranscriptFixture(dbPath);
    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;

    const result = readOpenClawSqliteTranscript({
      dbPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
      maxEvents: 10,
    });

    assert.deepEqual(result.chunks.map((chunk) => chunk.text), [
      "User message:\nDecision: run the release gate before rollout.",
      "Assistant tool names: synthetic_lookup",
      "Assistant message:\nWorkflow: verify doctor after every deployment.",
    ]);
    assert.ok(result.chunks.every((chunk) =>
      chunk.source_type === "openclaw_sqlite_transcript"
      && chunk.scope === "principal:telegram:default:joy"
      && !chunk.source_id.includes("session-1")));
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, /fixture-secret-must-not-escape|private chain/u);
    assert.deepEqual(result.inspection, {
      schemaVersion: 1,
      source: "openclaw-agent-sqlite",
      sourceType: "openclaw_sqlite_transcript",
      readOnly: true,
      exactSession: true,
      scannedEvents: 6,
      eligibleEvents: 3,
      toolResultBodiesEligible: false,
      toolArgumentsEligible: false,
      thinkingEligible: false,
    });
    assert.deepEqual(readFileSync(dbPath), before);
    assert.equal(statSync(dbPath).mtimeMs, beforeMtime);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite transcript source accepts the current OpenClaw session_windows catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-transcript-current-schema-"));
  try {
    const dbPath = join(root, "openclaw-agent.sqlite");
    createTranscriptFixture(dbPath, { sessionCatalog: "session_windows" });
    const result = readOpenClawSqliteTranscript({
      dbPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
      maxEvents: 10,
    });
    assert.equal(result.inspection.exactSession, true);
    assert.equal(result.inspection.eligibleEvents, 3);
    assert.ok(result.chunks.every((chunk) => chunk.scope === "principal:telegram:default:joy"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite transcript source fails closed on empty windows, unsafe files, and unsupported schema", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-transcript-fail-closed-"));
  try {
    const dbPath = join(root, "openclaw-agent.sqlite");
    createTranscriptFixture(dbPath);
    assert.throws(() => readOpenClawSqliteTranscript({
      dbPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
      startMs: 9_000,
      maxEvents: 10,
    }), /no eligible transcript events/u);
    assert.throws(() => readOpenClawSqliteTranscript({
      dbPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
      startMs: 2_000,
      endMs: 1_000,
    }), /lower than endMs/u);

    if (process.platform !== "win32") {
      chmodSync(dbPath, 0o640);
      assert.throws(() => readOpenClawSqliteTranscript({
        dbPath,
        sessionId: "session-1",
        scope: "principal:telegram:default:joy",
      }), /owner-only/u);
      chmodSync(dbPath, 0o600);
      const walPath = `${dbPath}-wal`;
      writeFileSync(walPath, "");
      chmodSync(walPath, 0o640);
      assert.throws(() => readOpenClawSqliteTranscript({
        dbPath,
        sessionId: "session-1",
        scope: "principal:telegram:default:joy",
      }), /transcript WAL must be owner-only/u);
      rmSync(walPath);
      const linkPath = join(root, "transcript-link.sqlite");
      symlinkSync(dbPath, linkPath);
      assert.throws(() => readOpenClawSqliteTranscript({
        dbPath: linkPath,
        sessionId: "session-1",
        scope: "principal:telegram:default:joy",
      }), /symbolic link/u);
    }

    const invalidPath = join(root, "invalid.sqlite");
    const invalid = new DatabaseSync(invalidPath);
    invalid.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY)");
    invalid.close();
    enforcePrivatePath(invalidPath, { kind: "file" });
    assert.throws(() => readOpenClawSqliteTranscript({
      dbPath: invalidPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
    }), /transcript_events missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcript chunks remain scope-bound and digest dry-run writes no ledger or memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-transcript-digest-"));
  const memory = createMemoryTruthDb();
  try {
    const dbPath = join(root, "openclaw-agent.sqlite");
    createTranscriptFixture(dbPath);
    const transcript = readOpenClawSqliteTranscript({
      dbPath,
      sessionId: "session-1",
      scope: "principal:telegram:default:joy",
      maxEvents: 10,
    });
    assert.throws(() => collectDigestChunks(memory, {
      scope: "principal:telegram:default:someone-else",
      inputChunks: transcript.chunks,
      maxChunks: 10,
    }), /scope does not match/u);

    const result = await runDigestPipeline(memory, {
      scope: "principal:telegram:default:joy",
      inputChunks: transcript.chunks,
      sourceType: "openclaw_sqlite_transcript",
      maxChunks: 10,
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.source.source_type, "openclaw_sqlite_transcript");
    assert.equal(result.source.chunks_seen, 3);
    assert.equal(memory.prepare(
      "SELECT COUNT(*) AS count FROM memory_truth",
    ).get().count, 0);
    assert.equal(memory.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='openclaw_digest_runs'",
    ).get().count, 0);
  } finally {
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});
