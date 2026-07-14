import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { decideClawLorePhase9CutoverV1 } =
  jiti("../src/v2/application/phase9-cutover-decision.ts");

function currentInput() {
  return {
    live: {
      candidateRows: 569,
      candidateUnverifiedRows: 569,
      activeRows: 0,
      activeInjectableRows: 0,
      contentDivergenceRows: 47,
      integrity: "ok",
      foreignKeyViolations: 0,
    },
    promotion: { eligibleRows: 0, lifecycleRolloutSelectable: false },
    phase8g: {
      proposedSoftArchiveRows: 24,
      retainedForVerificationRows: 34,
      boundedRewriteHoldRows: 0,
      mutationReadyRows: 0,
    },
    runtime: {
      configuredMode: "shadow",
      configuredContextEngine: "compatibility",
      cutoverModeImplemented: false,
      v1FallbackReads: true,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}

test("Phase 9 makes an explicit no-cutover decision from current live blockers", () => {
  const result = decideClawLorePhase9CutoverV1(currentInput());
  assert.equal(result.status, "pass");
  assert.equal(result.decision, "no_cutover");
  assert.deepEqual(result.blockers, [
    "no_active_verified_memory",
    "no_eligible_candidate_promotion",
    "candidate_lifecycle_rollout_not_selectable",
    "candidate_verification_debt_present",
    "phase8g_archive_proposals_unapplied",
    "v1_v2_current_content_divergence_present",
    "runtime_cutover_mode_not_implemented",
  ]);
  assert.equal(result.keepV1FallbackReads, true);
  assert.equal(result.keepReadOnlyShadow, true);
  assert.equal(result.authorizesLifecycleMutation, false);
  assert.equal(result.authorizesFinalRecall, false);
});

test("Phase 9 fails closed when no blocker remains but no separately authorized cutover exists", () => {
  const input = currentInput();
  input.live = {
    candidateRows: 0,
    candidateUnverifiedRows: 0,
    activeRows: 1,
    activeInjectableRows: 1,
    contentDivergenceRows: 0,
    integrity: "ok",
    foreignKeyViolations: 0,
  };
  input.promotion = { eligibleRows: 1, lifecycleRolloutSelectable: true };
  input.phase8g.proposedSoftArchiveRows = 0;
  input.runtime.cutoverModeImplemented = true;
  assert.throws(
    () => decideClawLorePhase9CutoverV1(input),
    /requires a separately authorized implementation/,
  );
});

test("Phase 9 reports runtime and database boundary failures without authorizing recovery", () => {
  const input = currentInput();
  input.runtime.configuredMode = "disabled";
  input.live.integrity = "failed";
  input.live.foreignKeyViolations = 1;
  const result = decideClawLorePhase9CutoverV1(input);
  assert.equal(result.blockers.includes("runtime_not_on_read_only_shadow"), true);
  assert.equal(result.blockers.includes("database_integrity_not_proven"), true);
  assert.equal(result.authorizesContextEngine, false);
  assert.equal(result.authorizesPromptMutation, false);
});
