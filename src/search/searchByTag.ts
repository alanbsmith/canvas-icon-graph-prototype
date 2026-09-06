// Search mode 3 of 4: find icons connected to a given tag or synonym.

import neo4j, { type Driver } from 'neo4j-driver';
import { buildFuzzyOrExactQuery } from './luceneQuery.ts';
import { toIconSearchResult } from './toIconSearchResult.ts';
import type { IconSearchResult } from './types.ts';

/**
 * Searches for icons by tag name. One Lucene query handles exact AND
 * fuzzy (typo-tolerant) matching in a single round trip (see
 * buildFuzzyOrExactQuery in luceneQuery.ts) -- unlike name search, there's
 * no need for a separate fallback pass here, since a Tag node's `value` is
 * always a single short word/phrase rather than something with a
 * meaningful "exact vs. partial" distinction worth trying first.
 *
 * An icon can be connected to the same matching tag via BOTH HAS_TAG and
 * HAS_SYNONYM (e.g. "airplane" might be a primary tag on one icon and a
 * synonym on another) -- `max(score)` and `collect(DISTINCT type(rel))`
 * make sure that shows up as ONE result with both relationship types
 * noted in `matchedVia`, not two duplicate rows for the same icon.
 */
export async function searchIconsByTag(driver: Driver, tag: string, limit: number): Promise<IconSearchResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      CALL db.index.fulltext.queryNodes('tagValueIndex', $luceneQuery) YIELD node AS t, score
      MATCH (i:Icon)-[rel:HAS_TAG|HAS_SYNONYM]->(t)
      MATCH (i)-[:IN_CATEGORY]->(c:Category)
      WITH i, c, max(score) AS score, collect(DISTINCT type(rel)) AS matchedVia
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, score, matchedVia
      ORDER BY score DESC
      LIMIT $limit
      `,
      { luceneQuery: buildFuzzyOrExactQuery(tag), limit: neo4j.int(limit) },
    );
    return result.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}
