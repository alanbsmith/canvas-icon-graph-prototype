// Every search query in this folder returns the same set of columns
// (name, filename, figmaName, category, shortDescription, score, and
// sometimes matchedVia) -- this file is the one place that converts a raw
// Neo4j driver `Record` into our `IconSearchResult` shape, so that
// conversion logic exists exactly once instead of being copy-pasted into
// every search*.ts file.

import type { Record as Neo4jRecord } from 'neo4j-driver';
import type { IconSearchResult } from './types.ts';

/**
 * Converts one row from a Cypher query into an `IconSearchResult`. Every
 * search query's RETURN clause is written to produce exactly these column
 * names (see searchByName.ts, searchByCategory.ts, etc.) so this one
 * function works for all of them.
 *
 * `matchedVia` is optional in the underlying query results (only
 * searchByTag.ts's query currently returns it) -- when present, it's a
 * list like `["HAS_TAG"]` or `["HAS_TAG", "HAS_SYNONYM"]`; we join it into
 * a single readable string for the `matchedOn` field.
 */
export function toIconSearchResult(record: Neo4jRecord): IconSearchResult {
  const matchedVia = record.keys.includes('matchedVia') ? (record.get('matchedVia') as string[]) : undefined;

  return {
    name: record.get('name') as string,
    filename: record.get('filename') as string,
    figmaName: record.get('figmaName') as string,
    category: record.get('category') as string,
    shortDescription: record.get('shortDescription') as string,
    score: record.get('score') as number,
    matchedOn: matchedVia?.join(', '),
  };
}
