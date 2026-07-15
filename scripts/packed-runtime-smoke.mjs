import assert from "node:assert/strict";

import plugin from "../dist/index.js";

assert.equal(plugin.id, "clawlore");
assert.equal(plugin.name, "ClawLore");
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.equal(typeof plugin.register, "function");

const registrations = [];
plugin.register({
  registrationMode: "cli-metadata",
  pluginConfig: {},
  config: {},
  registerCli(builder, options) {
    registrations.push({ builder, options });
  },
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
});

assert.equal(registrations.length, 1);
assert.equal(typeof registrations[0].builder, "function");
assert.deepEqual(
  registrations[0].options.commands,
  ["clawlore", "scope-recall", "memory-pro"],
);

process.stdout.write(`packed runtime smoke ok: ${plugin.id}@${plugin.version}\n`);
