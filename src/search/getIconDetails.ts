// A lookup (not search) function: given an icon's exact name, returns its
// full details -- everything a search result leaves out (all tags, all
// synonyms, use cases), for when a caller already knows which icon they
// want and needs the complete picture.

import type { Driver } from 'neo4j-driver';

export interface IconDetails {
  name: string;
  filename: string;
  figmaName: string;
  shortDescription: string;
  useCases: string[];
  category: string | null;
  tags: string[];
  synonyms: string[];
}

/** Returns full details for one icon by exact name, or `null` if no such icon exists. */
export async function getIconDetails(driver: Driver, name: string): Promise<IconDetails | null> {
  const session = driver.session();
  try {
    // `OPTIONAL MATCH` for tags/synonyms/category means an icon with,
    // say, no synonyms yet still returns successfully (with an empty
    // synonyms list) instead of being excluded entirely -- a plain
    // (non-optional) MATCH would require ALL of these relationships to
    // exist for the icon to show up at all.
    //
    // Cypher gotcha this works around (the same one fixed in
    // graph/loadGraph.ts's replaceRelationships()): if an icon has, say,
    // 10 tags and 8 synonyms, running BOTH "OPTIONAL MATCH tags" and
    // "OPTIONAL MATCH synonyms" back to back with no aggregation in
    // between would multiply out to 10*8=80 rows (every tag row paired
    // with every synonym row) before collect(DISTINCT ...) cleans it up
    // -- correct final answer, but a lot of wasted intermediate work.
    // Aggregating (`collect(DISTINCT ...)`) immediately after EACH
    // OPTIONAL MATCH, via its own `WITH`, collapses back to one row per
    // icon before the next OPTIONAL MATCH ever runs, so there's no
    // cross-product to begin with.
    const result = await session.run(
      `
      MATCH (i:Icon {name: $name})
      OPTIONAL MATCH (i)-[:HAS_TAG]->(tag:Tag)
      WITH i, collect(DISTINCT tag.value) AS tags
      OPTIONAL MATCH (i)-[:HAS_SYNONYM]->(synonym:Tag)
      WITH i, tags, collect(DISTINCT synonym.value) AS synonyms
      OPTIONAL MATCH (i)-[:IN_CATEGORY]->(c:Category)
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             i.shortDescription AS shortDescription, i.useCases AS useCases,
             c.name AS category, tags, synonyms
      `,
      { name },
    );

    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0];
    return {
      name: record.get('name'),
      filename: record.get('filename'),
      figmaName: record.get('figmaName'),
      shortDescription: record.get('shortDescription'),
      useCases: record.get('useCases'),
      category: record.get('category'),
      tags: record.get('tags'),
      synonyms: record.get('synonyms'),
    };
  } finally {
    await session.close();
  }
}
