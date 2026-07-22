import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lancedb from "@lancedb/lancedb";
import { auditPersistedSecrets } from "../scripts/clawlore-persisted-secret-audit.mjs";

test("persisted-secret audit is read-only and emits only counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-persisted-secret-audit-"));
  const memoryPath = join(root, "memory.sqlite3");
  const conversationPath = join(root, "conversation.sqlite3");
  const vectorPath = join(root, "vectors");
  const secret = "SyntheticBraveCredentialValue123456";
  try {
    const memory = new DatabaseSync(memoryPath);
    memory.exec("CREATE TABLE memory_truth(id TEXT PRIMARY KEY,text TEXT,metadata TEXT,metadata_text TEXT)");
    memory.exec("CREATE TABLE nightly_digest_runs(id TEXT PRIMARY KEY,notes TEXT)");
    memory.prepare("INSERT INTO memory_truth VALUES(?,?,?,?)")
      .run("safe", "Release validation is required.", "{}", "");
    memory.prepare("INSERT INTO memory_truth VALUES(?,?,?,?)")
      .run("unsafe", `${secret} 这是BRAVE的API`, "{}", "");
    memory.prepare("INSERT INTO nightly_digest_runs VALUES(?,?)")
      .run("run", JSON.stringify({ sample: `${secret} is OpenAI API key` }));
    memory.close();

    const conversation = new DatabaseSync(conversationPath);
    conversation.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY,summary TEXT,detail TEXT,source_detail TEXT,tools_used TEXT,model_used TEXT)");
    conversation.prepare("INSERT INTO conversations(summary,detail) VALUES(?,?)")
      .run("safe summary", `Authorization: Bearer ${"A".repeat(32)}`);
    conversation.close();
    await chmod(memoryPath, 0o600);
    await chmod(conversationPath, 0o600);
    await writeFile(`${conversationPath}-wal`, "", { mode: 0o644 });
    await mkdir(vectorPath, { mode: 0o755 });
    const vectorDb = await lancedb.connect(vectorPath);
    const vectorTable = await vectorDb.createTable("memories", [{
      id: "unsafe-vector",
      text: `${secret} 这是BRAVE的API`,
      metadata: "{}",
      vector: [1, 0, 0, 0],
    }]);
    await vectorTable.close?.();
    await vectorDb.close?.();
    await chmod(vectorPath, 0o755);

    const report = await auditPersistedSecrets({
      memoryDb: memoryPath,
      conversationDb: conversationPath,
      lancedbDir: vectorPath,
    });
    assert.equal(report.status, "fail");
    assert.equal(report.readOnly, true);
    assert.equal(report.emitsSecretValues, false);
    assert.ok(report.totals.secretBearingRows >= 3);
    assert.ok(report.databases.some((database) => database.findings
      .some((finding) => finding.patternCounts["provider-key-context-reversed"] >= 1)));
    assert.equal(report.databases.find((database) => database.kind === "vector")?.ownerOnlyMode, false);
    assert.ok(report.blockers.includes("database_file_not_owner_only"));
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(JSON.stringify(report).includes("Authorization: Bearer"), false);

    const memoryCleanup = new DatabaseSync(memoryPath);
    memoryCleanup.prepare("UPDATE memory_truth SET text=? WHERE id='unsafe'")
      .run("Credential material is stored only in the controlled vault.");
    memoryCleanup.prepare("UPDATE nightly_digest_runs SET notes=? WHERE id='run'").run("{}");
    memoryCleanup.close();
    const conversationCleanup = new DatabaseSync(conversationPath);
    conversationCleanup.prepare("UPDATE conversations SET detail=? WHERE id=1")
      .run("Authentication output was redacted before persistence.");
    conversationCleanup.close();
    await chmod(`${conversationPath}-wal`, 0o600);

    const clean = await auditPersistedSecrets({
      memoryDb: memoryPath,
      conversationDb: conversationPath,
    });
    assert.equal(clean.status, "pass");
    assert.equal(clean.totals.secretBearingRows, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
