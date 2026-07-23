import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { ProjectionWorkerV2 } = jiti("../src/v2/workers/projection-worker.ts");

function address() {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    visibility: "private",
    retention: "durable",
  };
}

function mutableClock() {
  let now = new Date("2026-07-21T00:00:00.000Z");
  let sequence = 0;
  return {
    now: () => now,
    id: () => `lease-${++sequence}`,
    advance(ms) { now = new Date(now.getTime() + ms); },
  };
}

function remember(truth, itemId) {
  return truth.remember({
    itemId,
    content: "projection lease fixture",
    category: "fact",
    address: address(),
    source: { sourceType: "user_message", observedAt: "2026-07-21T00:00:00.000Z" },
    actor: "principal:user-1",
    reason: "projection lease regression",
  });
}

async function processFirstTwoOutboxRows(truth) {
  const worker = new ProjectionWorkerV2(truth, ["fts", "vector", "relations"].map((projection) => ({
    projection,
    async apply() {},
  })));
  assert.equal((await worker.run(2)).processed, 2);
}

test("concurrent worker runs apply the same pending outbox row only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-claim-race-"));
  const path = join(root, "truth.sqlite");
  const clock = mutableClock();
  const firstTruth = new SqliteTruthStoreV2(path, clock);
  const secondTruth = new SqliteTruthStoreV2(path, clock);
  try {
    firstTruth.open();
    secondTruth.open();
    const receipt = remember(firstTruth, "projection-race-item");
    await processFirstTwoOutboxRows(firstTruth);

    let releaseApply;
    let notifyEntered;
    const release = new Promise((resolve) => { releaseApply = resolve; });
    const entered = new Promise((resolve) => { notifyEntered = resolve; });
    const calls = [];
    const adapters = ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row) {
        calls.push(row.outboxId);
        notifyEntered();
        await release;
      },
    }));
    const firstWorker = new ProjectionWorkerV2(firstTruth, adapters, {
      owner: "concurrent-worker-a",
      leaseDurationMs: 30_000,
    });
    const secondWorker = new ProjectionWorkerV2(secondTruth, adapters, {
      owner: "concurrent-worker-b",
      leaseDurationMs: 30_000,
    });

    const firstPromise = firstWorker.run(1);
    await entered;
    const second = await secondWorker.run(1);
    releaseApply();
    const first = await firstPromise;

    assert.deepEqual(calls, [receipt.outboxIds[2]]);
    assert.equal(first.processed, 1);
    assert.equal(second.processed, 0);
    assert.equal(second.failed, 0);
    assert.equal(firstTruth.inspectOutbox([receipt.outboxIds[2]])[0].processedAt !== undefined, true);
  } finally {
    secondTruth.close();
    firstTruth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired outbox leases recover and stale owner tokens cannot finish the new lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-lease-expiry-"));
  const path = join(root, "truth.sqlite");
  const clock = mutableClock();
  const first = new SqliteTruthStoreV2(path, clock);
  const second = new SqliteTruthStoreV2(path, clock);
  try {
    first.open();
    second.open();
    const receipt = remember(first, "projection-expiry-item");
    const firstClaim = first.claimNextOutbox({ owner: "worker-a", leaseDurationMs: 1_000 });
    assert.equal(firstClaim.row.outboxId, receipt.outboxIds[0]);
    assert.equal(second.claimNextOutbox({
      owner: "worker-b",
      leaseDurationMs: 1_000,
      excludeOutboxIds: receipt.outboxIds.slice(1),
    }), null);

    clock.advance(1_001);
    const recovered = second.claimNextOutbox({
      owner: "worker-b",
      leaseDurationMs: 1_000,
      excludeOutboxIds: receipt.outboxIds.slice(1),
    });
    assert.equal(recovered.row.outboxId, firstClaim.row.outboxId);
    assert.notEqual(recovered.token, firstClaim.token);
    assert.equal(first.markOutboxProcessed(firstClaim), false);
    assert.equal(first.recordOutboxFailure(firstClaim, "stale_worker"), false);
    assert.equal(second.markOutboxProcessed({ ...recovered, owner: "worker-a" }), false);
    assert.equal(second.markOutboxProcessed(recovered), true);
    assert.equal(first.inspectOutbox([receipt.outboxIds[0]])[0].processedAt !== undefined, true);
  } finally {
    second.close();
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease takeover cannot let a stale adapter overwrite the final projection state", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-fenced-takeover-"));
  const path = join(root, "truth.sqlite");
  const clock = mutableClock();
  const firstTruth = new SqliteTruthStoreV2(path, clock);
  const secondTruth = new SqliteTruthStoreV2(path, clock);
  firstTruth.open();
  secondTruth.open();
  try {
    const receipt = remember(firstTruth, "projection-fenced-item");
    const projectionState = new Map();
    let releaseOldApply;
    let notifyOldApplyEntered;
    const releaseOld = new Promise((resolve) => { releaseOldApply = resolve; });
    const oldApplyEntered = new Promise((resolve) => { notifyOldApplyEntered = resolve; });
    const oldAdapters = ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row) {
        if (row.outboxId === receipt.outboxIds[0]) {
          notifyOldApplyEntered();
          await releaseOld;
        }
        projectionState.set(projection, row.operation);
      },
    }));
    const currentAdapters = ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row) {
        projectionState.set(projection, row.operation);
      },
    }));
    const oldWorker = new ProjectionWorkerV2(firstTruth, oldAdapters, {
      owner: "stale-worker",
      leaseDurationMs: 100,
    });
    const takeoverWorker = new ProjectionWorkerV2(secondTruth, currentAdapters, {
      owner: "takeover-worker",
      leaseDurationMs: 100,
    });

    const oldRun = oldWorker.run(1);
    await oldApplyEntered;
    firstTruth.forget({
      itemId: "projection-fenced-item",
      actor: "principal:user-1",
      reason: "archive while old adapter is blocked",
    });
    firstTruth.forget({
      itemId: "projection-fenced-item",
      hardDelete: true,
      approved: true,
      actor: "principal:user-1",
      reason: "purge while old adapter is blocked",
    });
    clock.advance(101);

    const takeoverRun = takeoverWorker.run(1);
    await new Promise((resolve) => setImmediate(resolve));
    releaseOldApply();
    const [oldResult, takeoverResult] = await Promise.all([oldRun, takeoverRun]);

    assert.equal(oldResult.processed, 0);
    assert.equal(oldResult.failed, 1);
    assert.equal(oldResult.failures[0].errorCode, "projection_claim_lost");
    assert.equal(takeoverResult.processed, 1);

    for (let round = 0; round < 4 && firstTruth.listPendingOutbox().length > 0; round++) {
      const result = await takeoverWorker.run(100);
      assert.equal(result.failed, 0);
      assert.ok(result.processed > 0);
    }
    assert.equal(firstTruth.listPendingOutbox().length, 0);
    assert.deepEqual(Object.fromEntries(projectionState), {
      fts: "purge",
      vector: "purge",
      relations: "purge",
    });
  } finally {
    secondTruth.close();
    firstTruth.close();
    await rm(root, { recursive: true, force: true });
  }
});
