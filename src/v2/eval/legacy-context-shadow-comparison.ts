import {
  composeContextPack,
  renderCompatibilityContextPack,
} from "../application/context-composer.js";
import type { ContextPackV1 } from "../domain/context-pack.js";
import {
  adaptLegacyContextSources,
  renderLegacyContextSources,
  type LegacyContextSourceBundleV1,
  type LegacyContextSourceDefaultsV1,
  type LegacySourceAdaptationTraceV1,
} from "../adapters/openclaw/legacy-context-sources.js";

export interface LegacyContextShadowComparisonInput {
  traceId: string;
  availableTokens: number;
  bundle: LegacyContextSourceBundleV1;
  defaults: LegacyContextSourceDefaultsV1;
}

export interface LegacyContextShadowComparisonV1 {
  schemaVersion: 1;
  mode: "shadow";
  legacy: {
    hookOutputCount: number;
    blockTags: string[];
    chars: number;
  };
  unified: {
    contextPackCount: 1;
    selectedCount: number;
    chars: number;
  };
  parity: {
    candidateCount: number;
    preservedCandidateIds: string[];
    rejected: Array<{ memoryId: string; stage: string; reason: string }>;
  };
  sourceTrace: LegacySourceAdaptationTraceV1[];
  pack: ContextPackV1;
  renderedContext: string;
  hookResult?: undefined;
}

function selectedIds(pack: ContextPackV1): string[] {
  return [
    ...pack.profile,
    ...pack.projectFacts,
    ...pack.activeDecisions,
    ...pack.taskContext,
    ...pack.playbooks,
  ].map((item) => item.id).sort();
}

export function compareLegacyContextToContextPack(
  input: LegacyContextShadowComparisonInput,
): LegacyContextShadowComparisonV1 {
  const legacy = renderLegacyContextSources(input.bundle);
  const adapted = adaptLegacyContextSources(input.bundle, input.defaults);
  const pack = composeContextPack({
    traceId: input.traceId,
    actorAddress: input.defaults.actorAddress,
    availableTokens: input.availableTokens,
    candidates: adapted.candidates,
  });
  const renderedContext = renderCompatibilityContextPack(pack);
  return {
    schemaVersion: 1,
    mode: "shadow",
    legacy: {
      hookOutputCount: legacy.hookOutputs.length,
      blockTags: legacy.blockTags,
      chars: legacy.combinedContext.length,
    },
    unified: {
      contextPackCount: 1,
      selectedCount: pack.trace.selectedCount,
      chars: renderedContext.length,
    },
    parity: {
      candidateCount: adapted.candidates.length,
      preservedCandidateIds: selectedIds(pack),
      rejected: pack.trace.rejected.map((item) => ({ ...item })),
    },
    sourceTrace: adapted.trace,
    pack,
    renderedContext,
    hookResult: undefined,
  };
}
