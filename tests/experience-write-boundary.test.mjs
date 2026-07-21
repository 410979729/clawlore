import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { registerExperienceTools } = jiti("../src/experience-tools.ts");
const { createTaskEpisode, ensureExperienceSchema } = jiti("../src/experience-store.ts");

function managementTools(db) {
  const tools = new Map();
  registerExperienceTools({
    registerTool(factory, metadata) {
      tools.set(metadata.name, factory({ agentId: "agent-a", sessionId: "session-a" }));
    },
  }, {
    retriever: {},
    store: {},
    scopeManager: {
      getDefaultScope(agentId) { return `agent:${agentId}`; },
      getScopeFilter(agentId) { return [`agent:${agentId}`]; },
      isAccessible(scope, agentId) { return scope === `agent:${agentId}`; },
    },
    embedder: {},
    db: async () => db,
  }, { enableManagementTools: true });
  return tools;
}

test("episode management rejects secret-shaped writes without persistence or response echo", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureExperienceSchema(db);
    const tools = managementTools(db);
    const create = tools.get("scope_recall_episode_create");
    const synthetic = "SyntheticEpisodeBoundaryValue2468";
    const rejected = await create.execute("secret-create", {
      task_goal: `Document password=${synthetic} in a task episode`,
      task_class: "boundary-check",
    });
    assert.equal(rejected.isError, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_episodes").get().n, 0);
    assert.equal(JSON.stringify(rejected).includes(synthetic), false);

    assert.throws(() => createTaskEpisode(db, {
      scope_id: "agent:agent-a",
      session_id: "session-a",
      task_goal: "Inspect a safe nested-metadata boundary.",
      metadata: { nested: { password: synthetic } },
    }), /persistence safety policy/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_episodes").get().n, 0);

    const safeGoal = "Verify the episode persistence boundary.";
    const accepted = await create.execute("safe-create", {
      task_goal: safeGoal,
      task_class: "boundary-check",
    });
    assert.notEqual(accepted.isError, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_episodes").get().n, 1);
    assert.equal(JSON.stringify(accepted).includes(safeGoal), false);
  } finally {
    db.close();
  }
});
