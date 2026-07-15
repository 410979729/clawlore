import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

  const playbook = createPlaybook(db, { scope_id: "user:a", payload: payload() });
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
