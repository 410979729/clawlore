import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { adaptLegacyContextSources, renderLegacyContextSources } = jiti("../src/v2/adapters/openclaw/legacy-context-sources.ts");
const { compareLegacyContextToContextPack } = jiti("../src/v2/eval/legacy-context-shadow-comparison.ts");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/clawlore-legacy-context-shadow-v1.json", import.meta.url), "utf8"));

test("three legacy prompt producers adapt to typed ContextPack candidates", () => {
  const adapted = adaptLegacyContextSources(fixture.bundle, fixture.defaults);
  assert.equal(adapted.candidates.length, 5);
  assert.deepEqual(adapted.trace.map((item) => [item.source, item.outputCount]), [
    ["auto_recall", 2],
    ["inherited_rules", 1],
    ["derived_focus", 1],
    ["error_signals", 1],
  ]);
  assert.equal(adapted.candidates.find((item) => item.id === "legacy-preference-1")?.section, "profile");
  assert.equal(adapted.candidates.find((item) => item.id === "legacy-playbook-1")?.section, "playbooks");
  assert.equal(adapted.candidates.find((item) => item.id === "legacy-inherited-rule-001")?.section, "activeDecisions");
  assert.equal(adapted.candidates.find((item) => item.id === "legacy-derived-focus-001")?.section, "taskContext");
  assert.equal(adapted.candidates.find((item) => item.id === "legacy-error-signal-001")?.verification, "tool_verified");
});

test("shadow comparison consolidates three hook outputs into one ContextPack", () => {
  const result = compareLegacyContextToContextPack(fixture);
  assert.equal(result.mode, "shadow");
  assert.equal(result.legacy.hookOutputCount, 3);
  assert.deepEqual(result.legacy.blockTags, [
    "relevant-memories",
    "inherited-rules",
    "derived-focus",
    "error-detected",
  ]);
  assert.equal(result.unified.contextPackCount, 1);
  assert.equal(result.parity.candidateCount, 5);
  assert.equal(result.unified.selectedCount, 5);
  assert.equal(result.parity.rejected.length, 0);
  assert.equal(result.parity.preservedCandidateIds.length, 5);
  assert.equal(result.hookResult, undefined);
  assert.equal((result.renderedContext.match(/<context-pack\b/g) ?? []).length, 1);
});

test("shadow comparison is deterministic for the same fixture", () => {
  const first = compareLegacyContextToContextPack(fixture);
  const second = compareLegacyContextToContextPack(fixture);
  assert.deepEqual(second, first);
});

test("legacy identity debt is visible and denied by V2 policy", () => {
  const input = structuredClone(fixture);
  input.bundle.autoRecall = [{
    id: "legacy-unresolved-identity",
    text: "Legacy row without sender evidence.",
    scope: "agent:main",
    category: "fact",
    metadata: { state: "confirmed", memory_category: "cases" },
  }];
  input.bundle.inheritedRules = [];
  input.bundle.derivedFocus = [];
  input.bundle.errorSignals = [];
  const result = compareLegacyContextToContextPack(input);
  assert.equal(result.parity.candidateCount, 1);
  assert.equal(result.unified.selectedCount, 0);
  assert.deepEqual(result.parity.rejected, [{
    memoryId: "legacy-unresolved-identity",
    stage: "policy",
    reason: "private_principal_mismatch",
  }]);
  assert.match(result.sourceTrace[0].warnings[0], /no sender principal/);
});

test("unreviewed legacy playbook is intentionally rejected", () => {
  const input = structuredClone(fixture);
  input.bundle.autoRecall = [structuredClone(fixture.bundle.autoRecall[1])];
  delete input.bundle.autoRecall[0].metadata.verification_status;
  const result = compareLegacyContextToContextPack(input);
  assert.ok(result.parity.rejected.some((item) =>
    item.memoryId === "legacy-playbook-1"
    && item.stage === "playbook_review"
  ));
});

test("legacy reflection source caps remain explicit and reproducible", () => {
  const bundle = structuredClone(fixture.bundle);
  bundle.autoRecall = [];
  bundle.inheritedRules = Array.from({ length: 8 }, (_, index) => `rule-${index + 1}`);
  bundle.derivedFocus = [];
  bundle.errorSignals = [];
  const rendered = renderLegacyContextSources(bundle);
  const adapted = adaptLegacyContextSources(bundle, fixture.defaults);
  assert.equal(rendered.hookOutputs.length, 1);
  assert.equal(adapted.trace.find((item) => item.source === "inherited_rules")?.outputCount, 6);
  assert.equal(adapted.candidates.length, 6);
  assert.equal(adapted.trace.find((item) => item.source === "inherited_rules")?.warnings.length, 1);
});
