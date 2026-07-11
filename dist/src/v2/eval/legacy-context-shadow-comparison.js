import { composeContextPack, renderCompatibilityContextPack, } from "../application/context-composer.js";
import { adaptLegacyContextSources, renderLegacyContextSources, } from "../adapters/openclaw/legacy-context-sources.js";
function selectedIds(pack) {
    return [
        ...pack.profile,
        ...pack.projectFacts,
        ...pack.activeDecisions,
        ...pack.taskContext,
        ...pack.playbooks,
    ].map((item) => item.id).sort();
}
export function compareLegacyContextToContextPack(input) {
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
