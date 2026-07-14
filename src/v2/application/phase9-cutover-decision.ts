export type ClawLorePhase9NoCutoverBlockerV1 =
  | "no_active_verified_memory"
  | "no_eligible_candidate_promotion"
  | "candidate_lifecycle_rollout_not_selectable"
  | "candidate_verification_debt_present"
  | "phase8g_archive_proposals_unapplied"
  | "v1_v2_current_content_divergence_present"
  | "runtime_cutover_mode_not_implemented"
  | "runtime_not_on_read_only_shadow"
  | "database_integrity_not_proven";

export interface ClawLorePhase9DecisionInputV1 {
  live: {
    candidateRows: number;
    candidateUnverifiedRows: number;
    activeRows: number;
    activeInjectableRows: number;
    contentDivergenceRows: number;
    integrity: "ok" | "failed";
    foreignKeyViolations: number;
  };
  promotion: {
    eligibleRows: number;
    lifecycleRolloutSelectable: boolean;
  };
  phase8g: {
    proposedSoftArchiveRows: number;
    retainedForVerificationRows: number;
    boundedRewriteHoldRows: number;
    mutationReadyRows: 0;
  };
  runtime: {
    configuredMode: "disabled" | "shadow";
    configuredContextEngine: "compatibility" | "native-opt-in";
    cutoverModeImplemented: boolean;
    v1FallbackReads: true;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
}

export interface ClawLorePhase9NoCutoverDecisionV1 {
  status: "pass";
  decision: "no_cutover";
  blockers: ClawLorePhase9NoCutoverBlockerV1[];
  keepV1FallbackReads: true;
  keepReadOnlyShadow: true;
  automaticPromotionRows: 0;
  authorizesLifecycleMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresSeparateFutureReview: true;
}

export function decideClawLorePhase9CutoverV1(
  input: ClawLorePhase9DecisionInputV1,
): ClawLorePhase9NoCutoverDecisionV1 {
  const blockers: ClawLorePhase9NoCutoverBlockerV1[] = [];
  if (input.live.activeInjectableRows === 0 || input.live.activeRows === 0) {
    blockers.push("no_active_verified_memory");
  }
  if (input.promotion.eligibleRows === 0) blockers.push("no_eligible_candidate_promotion");
  if (!input.promotion.lifecycleRolloutSelectable) blockers.push("candidate_lifecycle_rollout_not_selectable");
  if (input.live.candidateRows > 0 && input.live.candidateUnverifiedRows > 0) {
    blockers.push("candidate_verification_debt_present");
  }
  if (input.phase8g.proposedSoftArchiveRows > 0) blockers.push("phase8g_archive_proposals_unapplied");
  if (input.live.contentDivergenceRows > 0) blockers.push("v1_v2_current_content_divergence_present");
  if (!input.runtime.cutoverModeImplemented) blockers.push("runtime_cutover_mode_not_implemented");
  if (
    input.runtime.configuredMode !== "shadow"
    || input.runtime.configuredContextEngine !== "compatibility"
    || input.runtime.v1FallbackReads !== true
    || input.runtime.contextEngineEnabled !== false
    || input.runtime.promptMutationEnabled !== false
    || input.runtime.finalRecallCutoverEnabled !== false
  ) blockers.push("runtime_not_on_read_only_shadow");
  if (input.live.integrity !== "ok" || input.live.foreignKeyViolations !== 0) {
    blockers.push("database_integrity_not_proven");
  }
  if (blockers.length === 0) {
    throw new Error("Phase 9 cutover requires a separately authorized implementation and cannot be inferred");
  }
  return {
    status: "pass",
    decision: "no_cutover",
    blockers,
    keepV1FallbackReads: true,
    keepReadOnlyShadow: true,
    automaticPromotionRows: 0,
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresSeparateFutureReview: true,
  };
}
