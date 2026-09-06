// Search mode 2 of 4: list every icon in a given category.

import neo4j, { type Driver } from 'neo4j-driver';
import { toIconSearchResult } from './toIconSearchResult.ts';
import { CANONICAL_CATEGORIES, InvalidCategoryError, type IconSearchResult } from './types.ts';

/**
 * Returns every icon in a category, alphabetically by name.
 *
 * Category membership is binary (an icon either is or isn't in a
 * category), not a matter of degree -- so unlike the other search modes,
 * there's no meaningful ranking here. `score` is fixed at 1.0 for every
 * result, kept only so `IconSearchResult`'s shape stays consistent across
 * all four search modes.
 */
export async function searchIconsByCategory(driver: Driver, category: string, limit: number): Promise<IconSearchResult[]> {
  // Validated case-insensitively (so "people" and "People" both work),
  // but the canonical, correctly-cased value is what actually gets used
  // in the query -- the graph's Category nodes are stored with their
  // canonical casing.
  const canonicalCategory = CANONICAL_CATEGORIES.find(
    (validCategory) => validCategory.toLowerCase() === category.trim().toLowerCase(),
  );
  if (!canonicalCategory) {
    throw new InvalidCategoryError(category);
  }

  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (i:Icon)-[:IN_CATEGORY]->(c:Category {name: $category})
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, 1.0 AS score
      ORDER BY i.name ASC
      LIMIT $limit
      `,
      { category: canonicalCategory, limit: neo4j.int(limit) },
    );
    return result.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}
