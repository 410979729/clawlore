import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { artifactBinding, releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  authorizeRuntimeReleaseV1,
} = jiti("../src/runtime-release-authorization.ts");
const {
  inspectRuntimeReleaseAuthorityV1,
} = jiti("../src/runtime-release-authority.ts");

const privateFixtureParent = process.platform === "win32" ? homedir() : tmpdir();
const freshNow = new Date("2026-07-19T00:01:00.000Z");
const expiredNow = new Date("2026-07-19T00:03:00.000Z");

function cutoverReadiness(binding, options = {}) {
  const createdAt = options.createdAt ?? "2026-07-19T00:00:00.000Z";
  const expiresAt = options.expiresAt ?? "2026-07-19T00:02:00.000Z";
  const provenance = releaseProvenance({
    ...binding,
    createdAt,
    expiresAt,
  });
  return buildReleaseReadinessReceipt({
    rolloutId: options.rolloutId ?? "durable-release-authority-fixture",
    requestedMode: "cutover",
    currentMode: "v2-write",
    evidence: {
      focusedTests: true,
      fullTests: true,
      typecheck: true,
      build: true,
      moduleBoundaries: true,
      releaseGate: true,
      snapshotVerified: true,
      migrationDrill: true,
      rollbackDrill: true,
      legacyHashUnchanged: true,
      forbiddenScopeViolations: 0,
    },
    provenance,
    now: () => options.now ?? freshNow,
  });
}

async function fixture() {
  const root = await mkdtemp(join(privateFixtureParent, "clawlore-release-authority-"));
  const sqlitePath = join(root, "memory.sqlite3");
  const readinessFile = join(root, "readiness.json");
  new DatabaseSync(sqlitePath).close();
  return { root, sqlitePath, readinessFile };
}

test("durable release authority survives truth writes and receipt expiry", async () => {
  const { root, sqlitePath, readinessFile } = await fixture();
  try {
    const initialBinding = artifactBinding();
    const readiness = cutoverReadiness(initialBinding);
    await writeFile(readinessFile, `${JSON.stringify(readiness)}\n`, { mode: 0o600 });

    const initial = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: initialBinding,
      expectedMode: "cutover",
      now: () => freshNow,
    });
    assert.deepEqual(initial.errors, []);
    assert.equal(initial.verification, "full-receipt");
    assert.equal(initial.authorityRecorded, true);
    assert.equal(initial.authority.status, "valid");

    const bindingAfterTruthWrite = {
      ...initialBinding,
      truthSnapshotDigest: "7".repeat(64),
    };
    const restarted = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: bindingAfterTruthWrite,
      expectedMode: "cutover",
      now: () => expiredNow,
    });
    assert.deepEqual(restarted.errors, []);
    assert.equal(restarted.readiness?.status, "ready");
    assert.equal(restarted.verification, "durable-release");
    assert.equal(restarted.authorityRecorded, false);
    assert.equal(restarted.authority.status, "valid");

    const tamperedReceipt = {
      ...readiness,
      provenance: {
        ...readiness.provenance,
        truthSnapshotDigest: bindingAfterTruthWrite.truthSnapshotDigest,
      },
    };
    await writeFile(readinessFile, `${JSON.stringify(tamperedReceipt)}\n`, { mode: 0o600 });
    const tampered = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: bindingAfterTruthWrite,
      expectedMode: "cutover",
      now: () => expiredNow,
    });
    assert.equal(tampered.readiness, undefined);
    assert.ok(tampered.errors.includes("runtime_release_authority_readiness_mismatch"));
    assert.ok(tampered.errors.includes("release_readiness_expired"));

    const verify = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const row = verify.prepare(`
        SELECT mode,initial_truth_snapshot_digest,authorized_at
        FROM clawlore_runtime_release_authority WHERE singleton=1
      `).get();
      assert.equal(row.mode, "cutover");
      assert.equal(row.initial_truth_snapshot_digest, initialBinding.truthSnapshotDigest);
      assert.ok(Number.isFinite(Date.parse(row.authorized_at)));
    } finally {
      verify.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh exact receipt can rotate the marker without a code change", async () => {
  const { root, sqlitePath, readinessFile } = await fixture();
  try {
    const initialBinding = artifactBinding();
    await writeFile(
      readinessFile,
      `${JSON.stringify(cutoverReadiness(initialBinding))}\n`,
      { mode: 0o600 },
    );
    assert.equal(authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: initialBinding,
      expectedMode: "cutover",
      now: () => freshNow,
    }).authorityRecorded, true);

    const bindingAfterTruthWrite = {
      ...initialBinding,
      truthSnapshotDigest: "7".repeat(64),
    };
    const rotationNow = new Date("2026-07-19T00:03:00.000Z");
    const refreshed = cutoverReadiness(bindingAfterTruthWrite, {
      rolloutId: "refreshed-receipt",
      createdAt: "2026-07-19T00:02:30.000Z",
      expiresAt: "2026-07-19T00:04:00.000Z",
      now: rotationNow,
    });
    await writeFile(readinessFile, `${JSON.stringify(refreshed)}\n`, { mode: 0o600 });
    const rotated = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: bindingAfterTruthWrite,
      expectedMode: "cutover",
      now: () => rotationNow,
    });
    assert.deepEqual(rotated.errors, []);
    assert.equal(rotated.verification, "full-receipt");
    assert.equal(rotated.authorityRecorded, true);
    assert.equal(rotated.authority.status, "valid");

    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.equal(
        db.prepare(`SELECT initial_truth_snapshot_digest
          FROM clawlore_runtime_release_authority WHERE singleton=1`).get()
          .initial_truth_snapshot_digest,
        bindingAfterTruthWrite.truthSnapshotDigest,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release or config changes require a new exact receipt before authority rotates", async () => {
  const { root, sqlitePath, readinessFile } = await fixture();
  try {
    const initialBinding = artifactBinding();
    await writeFile(
      readinessFile,
      `${JSON.stringify(cutoverReadiness(initialBinding))}\n`,
      { mode: 0o600 },
    );
    assert.equal(authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: initialBinding,
      expectedMode: "cutover",
      now: () => freshNow,
    }).authorityRecorded, true);

    const nextBinding = {
      ...initialBinding,
      runtimeDigest: "8".repeat(64),
      configDigest: "9".repeat(64),
    };
    const blocked = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: nextBinding,
      expectedMode: "cutover",
      now: () => freshNow,
    });
    assert.equal(blocked.readiness, undefined);
    assert.equal(blocked.authority.status, "mismatch");
    assert.deepEqual(blocked.authority.mismatchedFields, ["runtimeDigest", "configDigest"]);
    assert.ok(blocked.errors.includes("release_readiness_provenance_mismatch:runtimeDigest"));

    await writeFile(
      readinessFile,
      `${JSON.stringify(cutoverReadiness(nextBinding))}\n`,
      { mode: 0o600 },
    );
    const rotated = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: nextBinding,
      expectedMode: "cutover",
      now: () => freshNow,
    });
    assert.deepEqual(rotated.errors, []);
    assert.equal(rotated.authorityRecorded, true);
    assert.equal(rotated.authority.status, "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired first-use receipts and malformed authority fail closed", async () => {
  const { root, sqlitePath, readinessFile } = await fixture();
  try {
    const binding = artifactBinding();
    await writeFile(
      readinessFile,
      `${JSON.stringify(cutoverReadiness(binding))}\n`,
      { mode: 0o600 },
    );
    const expired = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: binding,
      expectedMode: "cutover",
      now: () => expiredNow,
    });
    assert.deepEqual(expired.errors, ["release_readiness_expired"]);
    assert.equal(expired.authorityRecorded, false);
    assert.equal(inspectRuntimeReleaseAuthorityV1({
      sqlitePath,
      expectedBinding: binding,
      expectedMode: "cutover",
    }).status, "absent");

    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec("CREATE TABLE clawlore_runtime_release_authority (singleton INTEGER PRIMARY KEY)");
      db.prepare("INSERT INTO clawlore_runtime_release_authority(singleton) VALUES (1)").run();
    } finally {
      db.close();
    }
    const malformed = authorizeRuntimeReleaseV1({
      sqlitePath,
      readinessFile,
      expectedBinding: binding,
      expectedMode: "cutover",
      now: () => freshNow,
    });
    assert.equal(malformed.authority.status, "invalid");
    assert.deepEqual(malformed.errors, ["runtime_release_authority_schema_invalid"]);
    assert.equal(malformed.readiness, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
