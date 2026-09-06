// Search mode 1 of 4: find an icon by its (exact, partial, or typo'd) name.

import neo4j, { type Driver } from 'neo4j-driver';
import { buildFuzzyOrExactQuery } from './luceneQuery.ts';
import { toIconSearchResult } from './toIconSearchResult.ts';
import type { IconSearchResult } from './types.ts';

/**
 * Searches for icons by name. Tries two passes:
 *   1. Exact match or "starts with" match against the icon's internal
 *      name or its Figma layer name -- fast, and correct for the common
 *      case of someone typing (all or part of) a name they already know.
 *   2. Only if pass 1 finds nothing: a fuzzy (typo-tolerant) full-text
 *      search, so a small typo like "acessibility" still finds
 *      "accessibility" instead of returning zero results.
 */
export async function searchIconsByName(driver: Driver, query: string, limit: number): Promise<IconSearchResult[]> {
  const session = driver.session();
  try {
    const exactOrPrefixResult = await session.run(
      `
      MATCH (i:Icon)-[:IN_CATEGORY]->(c:Category)
      WHERE toLower(i.name) = toLower($query) OR toLower(i.figmaName) = toLower($query)
         OR toLower(i.name) STARTS WITH toLower($query) OR toLower(i.figmaName) STARTS WITH toLower($query)
      WITH i, c,
           CASE WHEN toLower(i.name) = toLower($query) THEN 1.0
                WHEN toLower(i.figmaName) = toLower($query) THEN 0.9
                WHEN toLower(i.name) STARTS WITH toLower($query) THEN 0.7
                ELSE 0.6 END AS score
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, score
      ORDER BY score DESC, i.name ASC
      LIMIT $limit
      `,
      { query, limit: neo4j.int(limit) },
    );

    if (exactOrPrefixResult.records.length > 0) {
      return exactOrPrefixResult.records.map(toIconSearchResult);
    }

    // Fall back to fuzzy matching only when pass 1 found nothing -- this
    // keeps a clean exact/prefix match from ever being outranked by a
    // fuzzy one, and avoids paying for a full-text query on the common
    // case where the simple match already succeeded.
    const fuzzyResult = await session.run(
      `
      CALL db.index.fulltext.queryNodes('iconTextIndex', $luceneQuery) YIELD node AS i, score
      MATCH (i)-[:IN_CATEGORY]->(c:Category)
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, score
      ORDER BY score DESC
      LIMIT $limit
      `,
      { luceneQuery: buildFuzzyOrExactQuery(query), limit: neo4j.int(limit) },
    );

    return fuzzyResult.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}
