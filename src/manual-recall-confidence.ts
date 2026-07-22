export const MANUAL_RECALL_CONFIDENCE_POLICY = "manual-recall-confidence-v1";

interface ManualRecallCandidate {
  score: number;
  sources: {
    vector?: { score: number };
    bm25?: { score: number };
    reranked?: { score: number };
  };
}

export interface ManualRecallConfidencePolicy {
  minimumFinalScore: number;
  minimumLexicalScore: number;
  minimumVectorOnlyScore: number;
  minimumTopGap: number;
}

export interface ManualRecallConfidenceConfig {
  manualRecallMinScore?: number;
  manualRecallLexicalMinScore?: number;
  manualRecallVectorOnlyMinScore?: number;
  manualRecallMinimumTopGap?: number;
}

export interface ManualRecallConfidenceDecision<T extends ManualRecallCandidate> {
  policy: typeof MANUAL_RECALL_CONFIDENCE_POLICY;
  results: T[];
  rejectedCount: number;
}

const DEFAULT_POLICY: ManualRecallConfidencePolicy = {
  minimumFinalScore: 0.55,
  minimumLexicalScore: 0.05,
  minimumVectorOnlyScore: 0.85,
  minimumTopGap: 0.08,
};

function boundedScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

export function resolveManualRecallConfidencePolicy(
  config: ManualRecallConfidenceConfig,
): ManualRecallConfidencePolicy {
  return {
    minimumFinalScore: boundedScore(config.manualRecallMinScore, DEFAULT_POLICY.minimumFinalScore),
    minimumLexicalScore: boundedScore(
      config.manualRecallLexicalMinScore,
      DEFAULT_POLICY.minimumLexicalScore,
    ),
    minimumVectorOnlyScore: boundedScore(
      config.manualRecallVectorOnlyMinScore,
      DEFAULT_POLICY.minimumVectorOnlyScore,
    ),
    minimumTopGap: boundedScore(config.manualRecallMinimumTopGap, DEFAULT_POLICY.minimumTopGap),
  };
}

/**
 * Manual recall must be able to abstain. A low baseline cosine score is not
 * relevance evidence: accept lexical evidence, or one strongly separated
 * semantic winner. This policy is deliberately applied after the ordinary
 * retrieval pipeline so auto-recall and operator diagnostics keep their own
 * separately governed behavior.
 */
export function filterConfidentManualRecall<T extends ManualRecallCandidate>(
  candidates: T[],
  config: ManualRecallConfidenceConfig,
): ManualRecallConfidenceDecision<T> {
  const policy = resolveManualRecallConfidencePolicy(config);
  const topScore = candidates[0]?.score ?? 0;
  const secondScore = candidates[1]?.score ?? 0;
  const topGap = Math.max(0, topScore - secondScore);

  const results = candidates.filter((candidate, index) => {
    if (candidate.score < policy.minimumFinalScore) return false;

    const lexicalScore = candidate.sources.bm25?.score ?? 0;
    if (lexicalScore >= policy.minimumLexicalScore) return true;

    const semanticScore = Math.max(
      candidate.sources.vector?.score ?? 0,
      candidate.sources.reranked?.score ?? 0,
    );
    return index === 0
      && semanticScore >= policy.minimumVectorOnlyScore
      && topGap >= policy.minimumTopGap;
  });

  return {
    policy: MANUAL_RECALL_CONFIDENCE_POLICY,
    results,
    rejectedCount: candidates.length - results.length,
  };
}
