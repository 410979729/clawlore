import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { MemoryCenterServiceV1 } = jiti("../src/v2/application/memory-center-service.ts");

function actor() {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    conversationId: "dm-1",
    visibility: "private",
    retention: "durable",
  };
}

function clock() {
  let sequence = 0;
  return { now: () => new Date("2026-07-11T17:00:00.000Z"), id: () => `memory-center-${++sequence}` };
}

function input(itemId, content, overrides = {}) {
  return {
    itemId,
    content,
    category: "fact",
    address: actor(),
    source: { sourceType: "user_message", sourceId: `source-${itemId}`, observedAt: "2026-07-11T16:59:00Z" },
    actor: "principal:user-1",
    reason: "memory center fixture",
    ...overrides,
  };
}

function contextMemory(id, text, address = actor()) {
  return {
    id,
    section: "projectFacts",
    text,
    address,
    score: 0.9,
    confidence: 0.9,
    estimatedTokens: 8,
    verification: "user_confirmed",
    freshness: "current",
    citation: { sourceType: "user_message", sourceId: `source-${id}` },
  };
}

test("Memory Center is ACL-filtered and explains knowledge, use, review, correction, conflicts, and egress", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-memory-center-"));
  const path = join(root, "truth.sqlite");
  const truth = new SqliteTruthStoreV2(path, clock());
  try {
    truth.open();
    const current = truth.remember(input("current", "Current safe fact", { verification: "user_confirmed" }));
    const conflictA = truth.remember(input("conflict-a", "Deployment uses blue", { verification: "tool_verified" }));
    const conflictB = truth.remember(input("conflict-b", "Deployment uses green", { verification: "tool_verified" }));
    const obsoleteConflictA = truth.remember(input("obsolete-conflict-a", "Old endpoint A", { verification: "tool_verified" }));
    const obsoleteConflictB = truth.remember(input("obsolete-conflict-b", "Old endpoint B", { verification: "tool_verified" }));
    truth.remember(input("candidate", "Candidate preference", { lifecycle: "candidate" }));
    truth.remember(input("stale", "Expired service fact", { validUntil: "2026-07-10T00:00:00Z" }));
    truth.remember(input("disputed", "Disputed fact", { verification: "disputed" }));
    truth.remember(input("foreign-private", "Must never appear", {
      address: { ...actor(), principalId: "user-2" },
    }));
    truth.remember(input("other-conversation", "Other thread fact", {
      address: { ...actor(), visibility: "conversation", conversationId: "dm-2" },
    }));
    const corrected = truth.correct({
      itemId: "current",
      content: "Corrected safe fact",
      source: { sourceType: "user_message", sourceId: "correction-message", observedAt: "2026-07-11T17:00:00Z" },
      actor: "principal:user-1",
      reason: "user corrected the fact",
    });
    truth.correct({
      itemId: "obsolete-conflict-a",
      content: "Replacement endpoint A",
      source: { sourceType: "user_message", sourceId: "obsolete-correction", observedAt: "2026-07-11T17:00:00Z" },
      actor: "principal:user-1",
      reason: "obsolete conflict endpoint superseded",
    });
    const fixtureDb = new DatabaseSync(path);
    const markProcessed = fixtureDb.prepare(
      "UPDATE projection_outbox SET processed_at=? WHERE outbox_id=?",
    );
    current.outboxIds.forEach((id) => markProcessed.run("2026-07-11T17:00:00Z", id));
    fixtureDb.prepare(`UPDATE projection_outbox
      SET attempts=attempts+1,last_error='projection_timeout'
      WHERE outbox_id=?`).run(corrected.outboxIds[1]);
    fixtureDb.prepare(`INSERT INTO memory_relations
      (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
      VALUES (?,?,?,?,?)`).run("fixture-conflict", conflictA.revisionId, conflictB.revisionId, "contradicts", "2026-07-11T17:00:00Z");
    fixtureDb.prepare(`INSERT INTO memory_relations
      (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
      VALUES (?,?,?,?,?)`).run("fixture-obsolete-conflict", obsoleteConflictA.revisionId, obsoleteConflictB.revisionId, "contradicts", "2026-07-11T17:00:00Z");
    fixtureDb.close();

    const pack = {
      schemaVersion: 1,
      traceId: "trace-memory-center",
      actorAddress: actor(),
      budget: { availableTokens: 100, usedTokens: 16 },
      profile: [],
      projectFacts: [
        contextMemory("current", "Corrected safe fact"),
        contextMemory("foreign-private", "Must never appear", { ...actor(), principalId: "user-2" }),
      ],
      activeDecisions: [],
      taskContext: [],
      playbooks: [],
      conflicts: [],
      freshnessWarnings: [],
      trace: { candidateCount: 2, policyAllowedCount: 1, selectedCount: 2, rejected: [] },
    };
    const center = new MemoryCenterServiceV1(
      truth,
      () => new Date("2026-07-11T17:00:01.000Z"),
    ).build({
      actor: actor(),
      contextPack: pack,
      providerEgress: [{
        purpose: "embedding",
        provider: " hosted-provider ",
        enabled: true,
        redacted: true,
        dataClasses: ["memory_text", "memory_text"],
      }],
    });

    const knownIds = center.whatItKnows.map((item) => item.itemId);
    assert.ok(knownIds.includes("current"));
    assert.ok(knownIds.includes("conflict-a"));
    assert.equal(knownIds.includes("candidate"), false);
    assert.equal(knownIds.includes("stale"), false);
    assert.equal(knownIds.includes("disputed"), false);
    assert.equal(knownIds.includes("foreign-private"), false);
    assert.equal(knownIds.includes("other-conversation"), false);
    assert.equal(center.whatItKnows.find((item) => item.itemId === "current").content, "Corrected safe fact");
    assert.equal(center.whatItKnows.find((item) => item.itemId === "current").whyRemembered.sourceId, "correction-message");
    assert.deepEqual(center.usedThisTurn.map((item) => item.itemId), ["current"]);
    assert.deepEqual(center.reviewInbox.map((item) => item.itemId).sort(), ["candidate", "disputed"]);
    assert.equal(center.corrections.length, 2);
    assert.ok(center.corrections.some((event) => event.itemId === "current"
      && event.reason === "user corrected the fact"));
    assert.ok(center.corrections.some((event) => event.itemId === "obsolete-conflict-a"
      && event.reason === "obsolete conflict endpoint superseded"));
    assert.ok(center.conflictsAndStale.some((item) => item.itemId === "stale" && item.issue === "stale"));
    assert.ok(center.conflictsAndStale.some((item) => item.itemId === "conflict-a" && item.issue === "conflict"));
    assert.equal(center.conflictsAndStale.some((item) => item.itemId === "obsolete-conflict-a"), false);
    assert.equal(center.scopes.private, 8);
    assert.ok(center.projectionHealth.retrying >= 1);
    assert.deepEqual(center.providerEgress[0], {
      purpose: "embedding",
      provider: "hosted-provider",
      enabled: true,
      redacted: true,
      dataClasses: ["memory_text"],
    });
    assert.deepEqual(center.capabilities, {
      backup: "encrypted_snapshot",
      portableExport: "explicit_only",
      playbooks: "reviewed_only",
    });
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory Center rejects a ContextPack from another actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-memory-center-actor-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const service = new MemoryCenterServiceV1(truth);
    assert.throws(() => service.build({
      actor: actor(),
      contextPack: {
        schemaVersion: 1,
        traceId: "wrong-actor",
        actorAddress: { ...actor(), principalId: "user-2" },
        budget: { availableTokens: 0, usedTokens: 0 },
        profile: [], projectFacts: [], activeDecisions: [], taskContext: [], playbooks: [],
        conflicts: [], freshnessWarnings: [],
        trace: { candidateCount: 0, policyAllowedCount: 0, selectedCount: 0, rejected: [] },
      },
    }), /actor does not match/);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});
