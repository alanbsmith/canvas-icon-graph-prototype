// Combines several independently-ranked lists of search results into one
// final ranking. This is the "fusion" part of the hybrid natural-language
// search in searchByNaturalLanguage.ts, which runs a full-text (keyword)
// query and a vector (semantic similarity) query separately and needs to
// merge them into one sensible ordering.
//
// Written as a plain, pure function (no Neo4j/Ollama dependency at all)
// specifically so it's easy to read and easy to unit-test in isolation --
// this project could instead have done the fusion INSIDE one big Cypher
// query (Neo4j's own hybrid-search guide shows exactly that), but Cypher
// is new territory here, so keeping this one piece of genuinely tricky
// logic in plain, well-commented TypeScript was the deliberate choice.

import type { IconSearchResult } from './types.ts';

/**
 * Reciprocal Rank Fusion (RRF): combines multiple ranked lists by looking
 * at each item's POSITION in each list (not the raw score, which isn't
 * comparable between different kinds of search -- a Lucene relevance
 * score and a cosine-similarity score are on totally different scales).
 * An icon that ranks well in MULTIPLE lists ends up ranked higher overall
 * than one that ranks #1 in only a single list.
 *
 * The formula for one item's fused score is `sum(1 / (k + rank))` across
 * every list it appears in (rank starting at 1, not 0). `k` is a damping
 * constant -- k=60 is the value used in the original RRF research paper
 * and in Neo4j's own hybrid-search guide, and mainly controls how much
 * rank #1 is favored over rank #2, #3, etc. (a smaller k makes rank #1
 * matter much more; a larger k flattens the difference between ranks).
 */
export function reciprocalRankFusion(rankedLists: IconSearchResult[][], k = 60): IconSearchResult[] {
  const fusedScoreByIconName = new Map<string, number>();
  const resultByIconName = new Map<string, IconSearchResult>();

  for (const rankedList of rankedLists) {
    rankedList.forEach((result, indexInList) => {
      const rank = indexInList + 1; // ranks are 1-based, not 0-based
      const contribution = 1 / (k + rank);
      fusedScoreByIconName.set(result.name, (fusedScoreByIconName.get(result.name) ?? 0) + contribution);
      // If the same icon shows up in more than one list, keep whichever
      // copy we saw first for its other fields (name/filename/etc. are
      // identical either way -- only the per-list score/matchedOn differ,
      // and those get overwritten with the fused score below anyway).
      if (!resultByIconName.has(result.name)) {
        resultByIconName.set(result.name, result);
      }
    });
  }

  return [...fusedScoreByIconName.entries()]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([iconName, fusedScore]) => {
      const baseResult = resultByIconName.get(iconName);
      if (!baseResult) {
        // Can't actually happen -- every name in fusedScoreByIconName was
        // set alongside a resultByIconName entry above -- but keeps
        // TypeScript happy about `.get()` possibly returning undefined.
        throw new Error(`Unreachable: no result found for icon "${iconName}" during rank fusion`);
      }
      return { ...baseResult, score: fusedScore, matchedOn: 'hybrid' };
    });
}
