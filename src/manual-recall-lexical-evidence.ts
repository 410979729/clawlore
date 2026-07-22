/** Query-to-memory lexical evidence used only by explicit manual recall. */

export interface ManualRecallLexicalCandidate {
  score: number;
  entry?: { text?: string };
}

export interface ManualRecallLexicalEvidence<T extends ManualRecallLexicalCandidate> {
  candidate: T;
  lexicalCoverage: number;
  matchedFeatureCount: number;
  exactSymbolicMatch: boolean;
  answerShapeBonus: number;
  rankingScore: number;
}

const LATIN_STOP_WORDS = new Set([
  "a", "an", "and", "are", "before", "current", "do", "does", "for",
  "how", "in", "is", "of", "on", "or", "should", "the", "to", "what",
  "which", "with",
]);

// These interrogative/process phrases are common enough to create false BM25
// confidence on their own. Domain nouns and identifiers remain untouched.
const CJK_STOP_FEATURES = new Set([
  "为什么", "什么", "哪些", "是否", "应该", "当前", "默认", "相关", "内容",
  "要求", "记录", "怎么", "如何", "分别", "之后", "之前", "可以", "能否",
  "需要", "怎样", "学习", "顺序", "学习顺", "习顺序",
]);

interface LexicalFeatures {
  values: Set<string>;
  symbolic: Set<string>;
}

function extractFeatures(text: string): LexicalFeatures {
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const values = new Set<string>();
  const symbolic = new Set<string>();

  for (const token of normalized.match(/[a-z0-9][a-z0-9_.:+-]*/gu) ?? []) {
    if (token.length < 2 || LATIN_STOP_WORDS.has(token)) continue;
    const feature = `latin:${token}`;
    values.add(feature);
    if (token.length >= 5 || /[0-9_.:+-]/u.test(token)) symbolic.add(feature);
  }

  for (const segment of normalized.match(/[\u3400-\u9fff]+/gu) ?? []) {
    for (const width of [2, 3]) {
      for (let index = 0; index + width <= segment.length; index += 1) {
        const token = segment.slice(index, index + width);
        if (!CJK_STOP_FEATURES.has(token)) values.add(`cjk:${token}`);
      }
    }
  }

  return { values, symbolic };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * Re-rank a bounded candidate pool using query-to-text coverage. IDF is local
 * to the pool so common words such as a user's name cannot masquerade as a
 * strong lexical match. Raw memory text never leaves this function.
 */
export function rankManualRecallLexicalEvidence<T extends ManualRecallLexicalCandidate>(
  query: string,
  candidates: T[],
): ManualRecallLexicalEvidence<T>[] {
  const queryFeatures = extractFeatures(query);
  const asksWho = /(?:谁|\bwho\b)/iu.test(query);
  const candidateFeatures = candidates.map((candidate) =>
    extractFeatures(candidate.entry?.text ?? ""));
  const documentFrequency = new Map<string, number>();
  for (const features of candidateFeatures) {
    for (const feature of features.values) {
      documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
    }
  }

  return candidates.map((candidate, index) => {
    const features = candidateFeatures[index];
    let totalWeight = 0;
    let matchedWeight = 0;
    let matchedFeatureCount = 0;
    for (const feature of queryFeatures.values) {
      const frequency = documentFrequency.get(feature) ?? 0;
      const weight = Math.log((candidates.length + 1) / (frequency + 1)) + 1;
      totalWeight += weight;
      if (features.values.has(feature)) {
        matchedWeight += weight;
        matchedFeatureCount += 1;
      }
    }
    const lexicalCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
    const exactSymbolicMatch = [...queryFeatures.symbolic]
      .some((feature) => features.values.has(feature));
    const candidateText = candidate.entry?.text ?? "";
    const answerShapeBonus = asksWho && (
      (candidateText.match(/、/gu)?.length ?? 0) >= 2
      || (candidateText.match(/[,，;；]/gu)?.length ?? 0) >= 3
    ) ? 0.12 : 0;
    const rankingScore = clamp01(
      (candidate.score * 0.55) + (lexicalCoverage * 0.45) + answerShapeBonus,
    );
    return {
      candidate,
      lexicalCoverage,
      matchedFeatureCount,
      exactSymbolicMatch,
      answerShapeBonus,
      rankingScore,
    };
  }).sort((left, right) =>
    right.rankingScore - left.rankingScore
      || right.lexicalCoverage - left.lexicalCoverage
      || right.candidate.score - left.candidate.score);
}
