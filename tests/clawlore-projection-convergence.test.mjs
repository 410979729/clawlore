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
const { ProjectionConvergenceInspectorV2 } = jiti("../src/v2/operator/projection-convergence.ts");

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

function clock() {
  let sequence = 0;
  return { now: () => new Date("2026-07-11T15:00:00.000Z"), id: () => `convergence-${++sequence}` };
}

test("correction and forget receipts progress from pending through retry to converged", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-convergence-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const inspector = new ProjectionConvergenceInspectorV2(
      truth,
      () => new Date("2026-07-11T15:00:01.000Z"),
    );
    let failCorrectedVector = false;
    const calls = [];
    const worker = new ProjectionWorkerV2(truth, ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row, memory) {
        calls.push(`${row.operation}:${projection}:${memory?.lifecycle ?? "missing"}`);
        if (failCorrectedVector && row.operation === "upsert" && projection === "vector") {
          failCorrectedVector = false;
          throw new Error("temporary vector outage");
        }
      },
    })));

    const remembered = truth.remember({
      itemId: "projection-item",
      content: "old value",
      category: "fact",
      address: address(),
      source: { sourceType: "user_message", observedAt: "2026-07-11T15:00:00Z" },
      actor: "principal:user-1",
      reason: "remember fixture",
    });
    assert.equal(inspector.inspect(remembered.projection).status, "pending");
    assert.deepEqual((await worker.run()).failures, []);
    assert.equal(inspector.inspect(remembered.projection).status, "converged");

    const corrected = truth.correct({
      itemId: "projection-item",
      content: "corrected value",
      source: { sourceType: "user_message", observedAt: "2026-07-11T15:00:01Z" },
      actor: "principal:user-1",
      reason: "correction fixture",
    });
    const pending = inspector.inspect(corrected.projection);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.projections.map((item) => item.status), ["pending", "pending", "pending"]);

    failCorrectedVector = true;
    const failed = await worker.run();
    assert.equal(failed.processed, 2);
    assert.equal(failed.failed, 1);
    const retrying = inspector.inspect(corrected.projection);
    assert.equal(retrying.status, "retrying");
    assert.equal(retrying.projections.find((item) => item.projection === "vector").errorCode, "projection_error");
    assert.equal(retrying.projections.find((item) => item.projection === "vector").attempts, 1);

    assert.deepEqual((await worker.run()).failures, []);
    const correctedConverged = inspector.inspect(corrected.projection);
    assert.equal(correctedConverged.status, "converged");
    assert.equal(correctedConverged.projections.every((item) => item.status === "processed"), true);

    const forgotten = truth.forget({
      itemId: "projection-item",
      actor: "principal:user-1",
      reason: "forget fixture",
    });
    assert.equal(forgotten.projection.operation, "delete");
    assert.equal(inspector.inspect(forgotten.projection).status, "pending");
    assert.deepEqual((await worker.run()).failures, []);
    assert.equal(inspector.inspect(forgotten.projection).status, "converged");
    assert.equal(calls.filter((value) => value.startsWith("delete:")).length, 3);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operator inspection reports a missing or mismatched outbox row without claiming convergence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-missing-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const inspector = new ProjectionConvergenceInspectorV2(truth);
    const result = inspector.inspect({
      schemaVersion: 1,
      status: "pending",
      operation: "delete",
      expected: ["fts", "vector", "relations"],
      outboxIds: ["missing-fts", "missing-vector", "missing-relations"],
    });
    assert.equal(result.status, "pending");
    assert.deepEqual(result.projections.map((item) => item.status), ["missing", "missing", "missing"]);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-millisecond mutations stay ordered across two workers and converge on purge", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projection-order-"));
  const path = join(root, "truth.sqlite");
  const sharedClock = clock();
  const firstTruth = new SqliteTruthStoreV2(path, sharedClock);
  const secondTruth = new SqliteTruthStoreV2(path, sharedClock);
  try {
    firstTruth.open();
    secondTruth.open();
    const receipts = [];
    receipts.push(firstTruth.remember({
      itemId: "same-millisecond-item",
      content: "initial value",
      category: "fact",
      address: address(),
      source: { sourceType: "user_message", observedAt: "2026-07-11T15:00:00Z" },
      actor: "principal:user-1",
      reason: "same millisecond remember",
    }));
    receipts.push(firstTruth.correct({
      itemId: "same-millisecond-item",
      content: "corrected value",
      source: { sourceType: "user_message", observedAt: "2026-07-11T15:00:00Z" },
      actor: "principal:user-1",
      reason: "same millisecond correction",
    }));
    receipts.push(firstTruth.forget({
      itemId: "same-millisecond-item",
      actor: "principal:user-1",
      reason: "same millisecond archive",
    }));
    receipts.push(firstTruth.forget({
      itemId: "same-millisecond-item",
      hardDelete: true,
      approved: true,
      actor: "principal:user-1",
      reason: "same millisecond purge",
    }));

    const projectionState = new Map();
    const adapters = ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row) { projectionState.set(projection, row.operation); },
    }));
    const firstWorker = new ProjectionWorkerV2(firstTruth, adapters, { owner: "order-worker-a" });
    const secondWorker = new ProjectionWorkerV2(secondTruth, adapters, { owner: "order-worker-b" });
    for (let round = 0; round < 8 && firstTruth.listPendingOutbox().length > 0; round++) {
      const runs = await Promise.all([firstWorker.run(12), secondWorker.run(12)]);
      assert.equal(runs.reduce((sum, run) => sum + run.failed, 0), 0);
      assert.ok(runs.some((run) => run.processed > 0), "workers must make progress");
    }

    assert.equal(firstTruth.listPendingOutbox().length, 0);
    assert.deepEqual(Object.fromEntries(projectionState), {
      fts: "purge",
      vector: "purge",
      relations: "purge",
    });
    for (let projectionIndex = 0; projectionIndex < 3; projectionIndex++) {
      const ids = receipts.map((receipt) => receipt.outboxIds[projectionIndex]);
      const byId = new Map(firstTruth.inspectOutbox(ids).map((row) => [row.outboxId, row]));
      const order = ids.map((id) => byId.get(id).mutationOrder);
      assert.deepEqual(order, [...order].sort((a, b) => a - b));
    }
  } finally {
    secondTruth.close();
    firstTruth.close();
    await rm(root, { recursive: true, force: true });
  }
});
