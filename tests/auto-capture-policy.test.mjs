import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { detectCategory, shouldCapture } = jiti("../src/auto-capture-policy.ts");

test("regex capture policy preserves canonical English and Chinese signals", () => {
  assert.equal(shouldCapture("I prefer dark mode for all coding sessions"), true);
  assert.equal(shouldCapture("请记住我喜欢深色模式"), true);
  assert.equal(shouldCapture("We decided to use SQLite going forward"), true);
});

test("regex capture policy rejects management, unsafe, summary, and noisy input", () => {
  assert.equal(shouldCapture("How do I delete all memory entries?"), false);
  assert.equal(shouldCapture("记住 token=abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(shouldCapture("**Important**\n- remember this summary"), false);
  assert.equal(shouldCapture("I prefer this 😀😀😀😀"), false);
  assert.equal(shouldCapture("ok"), false);
});

test("regex capture categories remain compatibility-stable", () => {
  assert.equal(detectCategory("I prefer tea"), "preference");
  assert.equal(detectCategory("We decided to use SQLite"), "decision");
  assert.equal(detectCategory("My profile is called Joy"), "entity");
  assert.equal(detectCategory("The service is local"), "fact");
  assert.equal(detectCategory("Keep this nearby"), "other");
});
