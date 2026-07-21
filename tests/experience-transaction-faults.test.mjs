import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  createPlaybook,
  ensureExperienceSchema,
  getPlaybook,
  getPlaybookVersions,
  recordPlaybookFeedbackAtomically,
  reviewPlaybook,
} = jiti("../src/experience-store.ts");

function payload() {
  return {
    task_class: "atomic-release",
    title: "Atomic release playbook",
    trigger: "release transaction needs verification",
    goal: "Keep state and audit receipt atomic",
    preconditions: [{ check: "candidate database is isolated" }],
    steps: [{ number: 1, capability_class: "read_only", action: "verify", evidence_required: "receipt" }],
    pitfalls: [{ note: "partial commits invalidate audit receipts" }],
    verification: ["main row equals version snapshot"],
    cleanup: [],
    reuse_policy: {},
    status: "candidate",
    confidence: 0.7,
  };
}

test("playbook create and review roll back when version receipts fail", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  db.exec(`
    CREATE TRIGGER reject_initial_version
    BEFORE INSERT ON playbook_versions
    BEGIN SELECT RAISE(ABORT, 'injected version failure'); END;
  `);
  assert.throws(() => createPlaybook(db, { scope_id: "user:a", payload: payload() }), /injected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM procedural_playbooks").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM procedural_playbooks_fts").get().n, 0);
  db.exec("DROP TRIGGER reject_initial_version");

  const playbook = createPlaybook(db, {
    scope_id: "user:a",
    shared_scope_id: "project:release",
    payload: payload(),
    created_from_episode_id: "episode-1",
    evidence_anchors: ["receipt:one"],
    related_skills: ["release-gate"],
    environment_constraints: { platform: "linux", risk: "high" },
    metadata: { safe: "visible", nested: { review: "complete" } },
  });
  const initial = getPlaybookVersions(db, playbook.id, ["user:a"])[0].snapshot;
  assert.deepEqual(initial.evidence_anchors, ["receipt:one"]);
  assert.deepEqual(initial.related_skills, ["release-gate"]);
  assert.deepEqual(initial.environment_constraints, { platform: "linux", risk: "high" });
  assert.equal(initial.created_from_episode_id, "episode-1");
  assert.equal(initial.success_count, 0);
  assert.equal(initial.failure_count, 0);
  assert.equal(initial.stale_count, 0);
  assert.equal(initial.metadata.safe, "visible");
  assert.equal(initial.metadata.nested.review, "complete");
  assert.equal(typeof initial.created_at, "string");
  assert.equal(typeof initial.updated_at, "string");
  db.exec(`
    CREATE TRIGGER reject_later_version
    BEFORE INSERT ON playbook_versions
    WHEN NEW.version > 1
    BEGIN SELECT RAISE(ABORT, 'injected later version failure'); END;
  `);
  assert.throws(() => reviewPlaybook(db, {
    playbookId: playbook.id,
    action: "promote",
    scopeIds: ["user:a"],
  }), /injected/);
  assert.equal(getPlaybook(db, playbook.id, ["user:a"]).status, "candidate");
  assert.equal(getPlaybookVersions(db, playbook.id, ["user:a"]).length, 1);
  db.exec("DROP TRIGGER reject_later_version");

  recordPlaybookFeedbackAtomically(db, {
    playbook_id: playbook.id,
    scope_id: "user:a",
    decision: "used",
    confidence_at_use: 0.7,
    outcome: "success",
    counter: "success",
    scope_ids: ["user:a"],
  });

  const result = reviewPlaybook(db, {
    playbookId: playbook.id,
    action: "supersede",
    supersededBy: "replacement-playbook",
    scopeIds: ["user:a"],
  });
  assert.equal(result.reviewed, true);
  const durable = getPlaybook(db, playbook.id, ["user:a"]);
  const latest = getPlaybookVersions(db, playbook.id, ["user:a"])[0].snapshot;
  assert.equal(latest.status, durable.status);
  assert.equal(latest.superseded_by, durable.superseded_by);
  assert.equal(latest.success_count, durable.success_count);
  assert.deepEqual(latest.evidence_anchors, durable.evidence_anchors);
  assert.deepEqual(latest.related_skills, durable.related_skills);
  assert.deepEqual(latest.environment_constraints, durable.environment_constraints);
  assert.equal(latest.metadata.safe, durable.metadata.safe);
  assert.throws(() => createPlaybook(db, {
    scope_id: "user:a",
    payload: payload(),
    metadata: { nested: { password: "SyntheticPlaybookSecret2468" } },
  }), /persistence safety policy/);
  db.close();
});

test("feedback run, finish, and counter update commit or roll back together", () => {
  const db = new DatabaseSync(":memory:");
  ensureExperienceSchema(db);
  const playbook = createPlaybook(db, { scope_id: "user:a", payload: payload() });
  db.exec(`
    CREATE TRIGGER reject_success_counter
    BEFORE UPDATE OF success_count ON procedural_playbooks
    BEGIN SELECT RAISE(ABORT, 'injected counter failure'); END;
  `);
  assert.throws(() => recordPlaybookFeedbackAtomically(db, {
    playbook_id: playbook.id,
    scope_id: "user:a",
    decision: "used",
    confidence_at_use: 0.7,
    outcome: "success",
    counter: "success",
    scope_ids: ["user:a"],
  }), /injected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_runs").get().n, 0);
  assert.equal(db.prepare("SELECT success_count FROM procedural_playbooks WHERE id = ?").get(playbook.id).success_count, 0);
  db.close();
});

test("failed savepoint rollback performs a full rollback without releasing partial playbook state", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-experience-secondary-rollback-"));
  const path = join(root, "experience.sqlite");
  const db = new DatabaseSync(path);
  try {
    ensureExperienceSchema(db);
    db.exec("DROP TABLE procedural_playbooks_fts");
    let rollbackToAttempts = 0;
    let releasesAfterFailure = 0;
    let rollbackToFailed = false;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "exec") {
          return (sql) => {
            const statement = String(sql);
            if (statement.startsWith("ROLLBACK TO SAVEPOINT")) {
              rollbackToAttempts += 1;
              rollbackToFailed = true;
              throw new Error("synthetic secondary rollback failure");
            }
            if (rollbackToFailed && statement.startsWith("RELEASE SAVEPOINT")) {
              releasesAfterFailure += 1;
            }
            return target.exec(statement);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.throws(
      () => createPlaybook(wrapped, { scope_id: "user:a", payload: payload() }),
      (error) => {
        assert.equal(error.name, "SqliteSavepointCleanupError");
        assert.match(error.message, /no such table: procedural_playbooks_fts/);
        assert.equal(error.connectionPoisoned, false);
        assert.equal(error.errors.some((item) => /synthetic secondary rollback failure/.test(String(item))), true);
        return true;
      },
    );
    assert.equal(rollbackToAttempts, 1);
    assert.equal(releasesAfterFailure, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM procedural_playbooks").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playbook_versions").get().n, 0);

    ensureExperienceSchema(db);
    const recovered = createPlaybook(db, { scope_id: "user:a", payload: payload() });
    assert.equal(getPlaybook(db, recovered.id, ["user:a"]).id, recovered.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
