import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteExperienceStoreV2 } = jiti("../src/v2/storage/sqlite-experience-v2.ts");
const { SubagentExperienceServiceV2 } = jiti("../src/v2/application/subagent-experience-service.ts");
const { OpenClawSubagentExperienceAdapterV2 } = jiti("../src/v2/adapters/openclaw/subagent-experience-adapter.ts");

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

function sharedAddress() {
  return { ...actor(), visibility: "conversation", retention: "working" };
}

function memory(id, address = actor()) {
  return {
    id,
    section: "taskContext",
    text: `Context ${id}`,
    address,
    score: 0.9,
    confidence: 0.9,
    estimatedTokens: 8,
    verification: "tool_verified",
    freshness: "current",
  };
}

function pack() {
  return {
    schemaVersion: 1,
    traceId: "subagent-pack",
    actorAddress: actor(),
    budget: { availableTokens: 100, usedTokens: 16 },
    profile: [],
    projectFacts: [],
    activeDecisions: [],
    taskContext: [memory("private-parent"), memory("shared-explicit", sharedAddress())],
    playbooks: [], conflicts: [], freshnessWarnings: [],
    trace: { candidateCount: 2, policyAllowedCount: 2, selectedCount: 2, rejected: [] },
  };
}

function clock() {
  let sequence = 0;
  return {
    now: () => new Date("2026-07-12T01:30:00.000Z"),
    id: (prefix) => `${prefix}-${++sequence}`,
  };
}

function playbookInput(episodeIds) {
  return {
    episodeIds,
    parentSessionId: "parent",
    actor: actor(),
    title: "Verified deployment",
    trigger: "Deploy the fixture service",
    prerequisites: ["approved change"],
    steps: [
      { stepId: "backup", instruction: "Create a verified backup", requiredTools: ["exec"] },
      { stepId: "apply", instruction: "Apply the bounded change", requiredTools: ["patch"] },
    ],
    verificationGates: [{ gateId: "health", description: "Health probe passes" }],
    risks: ["service interruption"],
    cleanup: ["remove temporary fixture"],
  };
}

test("subagent snapshots and child writes preserve isolated/fork and candidate-only boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-subagent-boundary-"));
  const store = new SqliteExperienceStoreV2(join(root, "experience.sqlite"));
  store.open();
  try {
    const service = new SubagentExperienceServiceV2(store, clock());
    const adapter = new OpenClawSubagentExperienceAdapterV2(service);
    const isolated = adapter.prepareSubagentSpawn({
      mode: "isolated", parentSessionId: "parent", childSessionId: "child-1", runId: "run-1",
      taskGoal: "Inspect deployment", actor: actor(), contextPack: pack(),
      explicitlyAuthorizedMemoryIds: ["private-parent", "shared-explicit"],
    });
    assert.deepEqual(isolated.items.map((item) => item.memoryId), ["shared-explicit"]);
    assert.ok(isolated.items.every((item) => item.readOnly));

    const forked = adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "child-2", runId: "run-2",
      taskGoal: "Fork deployment context", actor: actor(), contextPack: pack(),
    });
    assert.deepEqual(forked.items.map((item) => item.memoryId), ["private-parent", "shared-explicit"]);

    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "Durable child fact", retention: "durable",
    }), /durable memory writes are denied/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "token=secret-shaped-value", retention: "working",
    }), /safety policy/);
    const scratch = service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "Candidate observation", retention: "working",
    });
    assert.equal(scratch.lifecycle, "candidate");
    assert.equal(scratch.retention, "working");

    const incomplete = adapter.onSubagentEnded({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", taskClass: "deployment",
      outcome: "incomplete", evidence: ["partial output"],
    });
    assert.equal(store.getSnapshot(isolated.snapshotId).status, "revoked");
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "late scratch", retention: "working",
    }), /active subagent snapshot not found/);
    assert.throws(() => adapter.onSubagentEnded({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", taskClass: "deployment", outcome: "success",
      toolReceiptIds: ["late-receipt"], evidence: ["late-evidence"],
    }), /active subagent snapshot not found/);
    const rejected = service.verifyByParent({
      episodeId: incomplete.episodeId, parentSessionId: "parent", accepted: true, reason: "not complete",
    });
    assert.equal(rejected.parentVerification, "disputed");
    assert.equal(rejected.lifecycle, "quarantined");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent verification, repeated evidence, replay, feedback, and supersede preserve lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-experience-lineage-"));
  const store = new SqliteExperienceStoreV2(join(root, "experience.sqlite"));
  store.open();
  try {
    const service = new SubagentExperienceServiceV2(store, clock());
    const adapter = new OpenClawSubagentExperienceAdapterV2(service);
    const episodes = [];
    for (const number of [1, 2]) {
      const snapshot = adapter.prepareSubagentSpawn({
        mode: "fork", parentSessionId: "parent", childSessionId: `child-${number}`, runId: `run-${number}`,
        taskGoal: "Deploy fixture", actor: actor(), contextPack: pack(),
      });
      const episode = adapter.onSubagentEnded({
        snapshotId: snapshot.snapshotId, childSessionId: snapshot.childSessionId,
        taskClass: "deployment", outcome: "success",
        toolReceiptIds: [`receipt-${number}`], evidence: [`health-ok-${number}`],
      });
      assert.throws(() => service.verifyByParent({
        episodeId: episode.episodeId, parentSessionId: "other-parent", accepted: true, reason: "wrong owner",
      }), /does not own/);
      episodes.push(service.verifyByParent({
        episodeId: episode.episodeId, parentSessionId: "parent", accepted: true, reason: "verified health",
      }));
    }

    const single = service.createPlaybookCandidate(playbookInput([episodes[0].episodeId]));
    assert.throws(() => service.createPlaybookCandidate({
      ...playbookInput([episodes[0].episodeId]), parentSessionId: "other-parent",
    }), /not owned/);
    assert.throws(() => service.promotePlaybook({
      playbookId: single.playbookId, actor: "parent", reason: "one success only",
    }), /single-run playbook/);

    const repeated = service.createPlaybookCandidate(playbookInput(episodes.map((item) => item.episodeId)));
    const promoted = service.promotePlaybook({
      playbookId: repeated.playbookId, actor: "parent", reason: "two verified independent runs",
    });
    assert.equal(promoted.lifecycle, "promoted");
    assert.equal(promoted.operatorReviewed, false);

    const failedReplay = service.evaluateReplay({
      playbookId: promoted.playbookId, actor: actor(), availableTools: ["exec"],
      satisfiedPrerequisites: [], completedStepIds: ["backup"], passedGateIds: [],
      disabledStepIds: ["apply"], outcome: "partial",
    });
    assert.equal(failedReplay.safeToUse, false);
    assert.deepEqual(failedReplay.missingTools, ["patch"]);
    assert.deepEqual(failedReplay.missingVerificationGates, ["health"]);

    const passedReplay = service.evaluateReplay({
      playbookId: promoted.playbookId, actor: actor(), availableTools: ["exec", "patch"],
      satisfiedPrerequisites: ["approved change"], completedStepIds: ["backup", "apply"],
      passedGateIds: ["health"], outcome: "success",
    });
    assert.equal(passedReplay.safeToUse, true);

    const next = service.supersedePlaybook({
      playbookId: promoted.playbookId, actor: "operator", reason: "add explicit rollback",
      steps: [...promoted.steps, { stepId: "rollback", instruction: "Rollback on failed health", requiredTools: ["exec"] }],
      verificationGates: promoted.verificationGates,
    });
    assert.equal(next.version, 2);
    assert.equal(next.predecessorId, promoted.playbookId);
    assert.equal(store.getPlaybook(promoted.playbookId).lifecycle, "superseded");
    assert.equal(store.getPlaybook(promoted.playbookId).supersededBy, next.playbookId);

    const reviewed = service.promotePlaybook({
      playbookId: next.playbookId, operatorReviewed: true, actor: "operator", reason: "manual review complete",
    });
    assert.equal(reviewed.operatorReviewed, true);
    const quarantined = service.recordFeedback({
      playbookId: reviewed.playbookId, outcome: "failure", actor: "parent", reason: "rollback gate failed",
    });
    assert.equal(quarantined.lifecycle, "quarantined");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
