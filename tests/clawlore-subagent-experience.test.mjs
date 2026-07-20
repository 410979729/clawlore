import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o077, 0);
      assert.equal((await stat(join(root, "experience.sqlite"))).mode & 0o077, 0);
    }
    const service = new SubagentExperienceServiceV2(store, clock());
    const adapter = new OpenClawSubagentExperienceAdapterV2(service);
    assert.throws(() => adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "secret-goal-child", runId: "secret-goal-run",
      taskGoal: '{"databasePassword":"synthetic-subagent-goal-secret"}', actor: actor(), contextPack: pack(),
    }), /safety policy/);
    const unsafePack = pack();
    unsafePack.taskContext[0].text = "serviceToken: synthetic-context-secret";
    assert.throws(() => adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "secret-context-child", runId: "secret-context-run",
      taskGoal: "Inspect deployment", actor: actor(), contextPack: unsafePack,
    }), /safety policy/);
    assert.throws(() => adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "attachment-goal-child", runId: "attachment-goal-run",
      taskGoal: "[Image attached at: /tmp/private-token-image.png]\nInspect deployment",
      actor: actor(), contextPack: pack(),
    }), /safety policy/);
    assert.throws(() => adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "unsafe-address-child", runId: "unsafe-address-run",
      taskGoal: "Inspect deployment",
      actor: { ...actor(), principalId: "/home/a/.ssh/id_ed25519" },
      contextPack: { ...pack(), actorAddress: { ...actor(), principalId: "/home/a/.ssh/id_ed25519" } },
    }), /safety policy/);
    const isolated = adapter.prepareSubagentSpawn({
      mode: "isolated", parentSessionId: "parent", childSessionId: "child-1", runId: "run-1",
      taskGoal: "Inspect deployment", actor: actor(), contextPack: pack(),
      explicitlyAuthorizedMemoryIds: ["private-parent", "shared-explicit"],
    });
    assert.deepEqual(isolated.items.map((item) => item.memoryId), ["shared-explicit"]);
    assert.ok(isolated.items.every((item) => item.readOnly));
    assert.throws(() => store.saveSnapshot({
      ...isolated, snapshotId: "direct-revoked-snapshot", status: "revoked",
    }), /must be active/);
    assert.throws(() => store.saveSnapshot({
      ...isolated, snapshotId: "direct-unsafe-snapshot",
      taskGoal: "Inspect /home/a/.ssh/id_ed25519 before continuing",
    }), /safety policy/);
    assert.equal(store.getSnapshot("direct-revoked-snapshot"), null);
    assert.equal(store.getSnapshot("direct-unsafe-snapshot"), null);

    const forked = adapter.prepareSubagentSpawn({
      mode: "fork", parentSessionId: "parent", childSessionId: "child-2", runId: "run-2",
      taskGoal: "Fork deployment context", actor: actor(), contextPack: pack(),
    });
    assert.deepEqual(forked.items.map((item) => item.memoryId), ["private-parent", "shared-explicit"]);
    assert.throws(() => adapter.onSubagentEnded({
      snapshotId: forked.snapshotId, childSessionId: "child-2", taskClass: "deployment", outcome: "success",
      toolReceiptIds: ["receipt-secret-evidence"],
      evidence: ["Authorization: Digest synthetic-subagent-evidence-secret"],
    }), /safety policy/);
    assert.equal(store.getSnapshot(forked.snapshotId).status, "active");

    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "Durable child fact", retention: "durable",
    }), /durable memory writes are denied/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "token=secret-shaped-value", retention: "working",
    }), /safety policy/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1",
      content: '{"databasePassword":"synthetic-subagent-secret"}', retention: "working",
    }), /safety policy/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1",
      content: "Authorization: Digest synthetic-subagent-credential-material", retention: "working",
    }), /safety policy/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1",
      content: "Inspect /home/a/.ssh/id_ed25519 before continuing", retention: "working",
    }), /safety policy/);
    assert.throws(() => service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1",
      content: "[Image attached at: /tmp/private-token-image.png]\nCandidate observation", retention: "working",
    }), /safety policy/);
    const scratch = service.recordChildScratch({
      snapshotId: isolated.snapshotId, childSessionId: "child-1", content: "Candidate observation", retention: "working",
    });
    assert.equal(scratch.lifecycle, "candidate");
    assert.equal(scratch.retention, "working");
    assert.throws(() => store.saveScratch({
      ...scratch, scratchId: "direct-unsafe-scratch",
      content: "Inspect /home/a/.ssh/id_ed25519 before continuing",
    }), /safety policy/);

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
    assert.throws(() => store.updateEpisode({
      ...rejected, taskGoal: "Changed immutable goal", updatedAt: "2026-07-12T01:31:00.000Z",
    }), /immutable fields/);
    assert.throws(() => store.appendEvent({
      eventId: "direct-unsafe-event", entityType: "episode", entityId: rejected.episodeId,
      eventType: "unsafe_event", actor: "operator",
      reason: "Read /home/a/.ssh/id_ed25519", createdAt: "2026-07-12T01:31:00.000Z",
    }), /safety policy/);
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
    assert.throws(() => store.savePlaybook({
      ...single, playbookId: "direct-promoted-playbook", lifecycle: "promoted", operatorReviewed: true,
    }), /must begin as an unreviewed candidate/);
    assert.throws(() => store.savePlaybook({
      ...single, playbookId: "direct-unsafe-playbook",
      trigger: "Read /home/a/.ssh/id_ed25519 before deployment",
    }), /safety policy/);
    assert.throws(() => store.updatePlaybook({
      ...single, title: "Changed immutable title", lifecycle: "promoted", operatorReviewed: true,
      updatedAt: "2026-07-12T01:31:00.000Z",
    }), /immutable fields/);
    assert.throws(() => service.createPlaybookCandidate({
      ...playbookInput([episodes[0].episodeId]),
      trigger: "databasePassword: |\n  synthetic-playbook-trigger-secret",
    }), /safety policy/);
    assert.throws(() => service.createPlaybookCandidate({
      ...playbookInput([episodes[0].episodeId]),
      steps: [{
        stepId: "unsafe",
        instruction: '{"serviceToken":"synthetic-playbook-step-secret"}',
        requiredTools: ["exec"],
      }],
    }), /safety policy/);
    assert.throws(() => service.createPlaybookCandidate({
      ...playbookInput([episodes[0].episodeId]), parentSessionId: "other-parent",
    }), /not owned/);
    assert.throws(() => service.promotePlaybook({
      playbookId: single.playbookId, actor: "parent", reason: "one success only",
    }), /single-run playbook/);

    const repeated = service.createPlaybookCandidate(playbookInput(episodes.map((item) => item.episodeId)));
    assert.throws(() => service.promotePlaybook({
      playbookId: repeated.playbookId, actor: "parent",
      reason: "Authorization: Bearer synthetic-promotion-secret-material",
    }), /safety policy/);
    assert.equal(store.getPlaybook(repeated.playbookId).lifecycle, "candidate");
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
