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

function contextPack() {
  return {
    schemaVersion: 1,
    traceId: "supersede-pack",
    actorAddress: actor(),
    budget: { availableTokens: 100, usedTokens: 0 },
    profile: [],
    projectFacts: [],
    activeDecisions: [],
    taskContext: [],
    playbooks: [],
    conflicts: [],
    freshnessWarnings: [],
    trace: { candidateCount: 0, policyAllowedCount: 0, selectedCount: 0, rejected: [] },
  };
}

function controlledClock() {
  let sequence = 0;
  return {
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    id(prefix) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    futureId(prefix, offset) {
      return `${prefix}-${sequence + offset}`;
    },
  };
}

function playbookInput(episodeIds) {
  return {
    episodeIds,
    parentSessionId: "parent",
    actor: actor(),
    title: "Transactional deployment",
    trigger: "Deploy the bounded fixture",
    prerequisites: ["approved change"],
    steps: [{ stepId: "apply", instruction: "Apply the bounded change", requiredTools: ["patch"] }],
    verificationGates: [{ gateId: "health", description: "Health probe passes" }],
    risks: ["service interruption"],
    cleanup: ["remove temporary fixture"],
  };
}

function createPromotedPlaybook(store, clock) {
  const service = new SubagentExperienceServiceV2(store, clock);
  const episodeIds = [];
  for (const number of [1, 2]) {
    const snapshot = service.prepareSpawn({
      mode: "fork",
      parentSessionId: "parent",
      childSessionId: `child-${number}`,
      runId: `run-${number}`,
      taskGoal: "Deploy fixture",
      actor: actor(),
      contextPack: contextPack(),
    });
    const episode = service.onSubagentEnded({
      snapshotId: snapshot.snapshotId,
      childSessionId: snapshot.childSessionId,
      taskClass: "deployment",
      outcome: "success",
      toolReceiptIds: [`receipt-${number}`],
      evidence: [`health-ok-${number}`],
    });
    episodeIds.push(service.verifyByParent({
      episodeId: episode.episodeId,
      parentSessionId: "parent",
      accepted: true,
      reason: "verified health",
    }).episodeId);
  }
  const candidate = service.createPlaybookCandidate(playbookInput(episodeIds));
  return {
    service,
    promoted: service.promotePlaybook({
      playbookId: candidate.playbookId,
      actor: "parent",
      reason: "two verified runs",
    }),
  };
}

test("playbook supersede rolls back successor and predecessor when event persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-playbook-supersede-event-"));
  const store = new SqliteExperienceStoreV2(join(root, "experience.sqlite"));
  store.open();
  try {
    const clock = controlledClock();
    const { service, promoted } = createPromotedPlaybook(store, clock);
    const successorId = clock.futureId("playbook", 1);
    const collidingEventId = clock.futureId("event", 2);
    store.appendEvent({
      eventId: collidingEventId,
      entityType: "playbook",
      entityId: promoted.playbookId,
      eventType: "collision_fixture",
      actor: "test",
      reason: "reserve event id",
      createdAt: "2026-07-23T08:00:00.000Z",
    });

    assert.throws(() => service.supersedePlaybook({
      playbookId: promoted.playbookId,
      actor: "operator",
      reason: "add rollback",
      steps: [
        ...promoted.steps,
        { stepId: "rollback", instruction: "Rollback after failed health", requiredTools: ["patch"] },
      ],
      verificationGates: promoted.verificationGates,
    }), /UNIQUE constraint failed/);

    assert.equal(store.getPlaybook(promoted.playbookId).lifecycle, "promoted");
    assert.equal(store.getPlaybook(promoted.playbookId).supersededBy, undefined);
    assert.equal(store.getPlaybook(successorId), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("playbook supersede is atomic under competing connections and exact replay is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-playbook-supersede-cas-"));
  const path = join(root, "experience.sqlite");
  const first = new SqliteExperienceStoreV2(path);
  const second = new SqliteExperienceStoreV2(path);
  first.open();
  second.open();
  try {
    const { promoted } = createPromotedPlaybook(first, controlledClock());
    const timestamp = "2026-07-23T08:01:00.000Z";
    const firstSuccessor = {
      ...promoted,
      playbookId: "playbook-successor-a",
      version: promoted.version + 1,
      lifecycle: "candidate",
      operatorReviewed: false,
      predecessorId: promoted.playbookId,
      supersededBy: undefined,
      steps: [
        ...promoted.steps,
        { stepId: "rollback-a", instruction: "Rollback using path A", requiredTools: ["patch"] },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const competingSuccessor = {
      ...firstSuccessor,
      playbookId: "playbook-successor-b",
      steps: [
        ...promoted.steps,
        { stepId: "rollback-b", instruction: "Rollback using path B", requiredTools: ["patch"] },
      ],
    };
    const firstEvent = {
      eventId: "event-successor-a",
      entityType: "playbook",
      entityId: promoted.playbookId,
      eventType: "playbook_superseded",
      actor: "operator-a",
      reason: "choose path A",
      createdAt: timestamp,
    };
    const competingEvent = {
      ...firstEvent,
      eventId: "event-successor-b",
      actor: "operator-b",
      reason: "choose path B",
    };

    first.supersedePlaybook(promoted, firstSuccessor, firstEvent);
    assert.throws(
      () => second.supersedePlaybook(promoted, competingSuccessor, competingEvent),
      /expected state is stale/,
    );
    assert.doesNotThrow(() => first.supersedePlaybook(promoted, firstSuccessor, firstEvent));

    assert.equal(first.getPlaybook(promoted.playbookId).lifecycle, "superseded");
    assert.equal(first.getPlaybook(promoted.playbookId).supersededBy, firstSuccessor.playbookId);
    assert.deepEqual(
      first.getPlaybook(firstSuccessor.playbookId),
      JSON.parse(JSON.stringify(firstSuccessor)),
    );
    assert.equal(first.getPlaybook(competingSuccessor.playbookId), null);
  } finally {
    second.close();
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});
