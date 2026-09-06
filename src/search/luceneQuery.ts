// Small helpers for building query strings for Neo4j's FULL-TEXT indexes
// (created in ../graph/schema.ts). Full-text indexes are powered by
// Apache Lucene under the hood, which has its own query syntax -- this
// file is the one place that knows the details, so every search function
// that touches a full-text index (searchByName's fuzzy fallback,
// searchByTag, searchByNaturalLanguage) can just call these instead of
// re-deriving Lucene syntax rules each time.
// Reference: https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/full-text-indexes/

// Lucene treats these characters as OPERATORS, not literal text -- e.g. a
// tag like "add-file" would otherwise be parsed as "add MINUS file"
// (Lucene's minus/NOT operator), silently changing the meaning of the
// search. Escaping a character with a backslash tells Lucene "treat this
// as a literal character, not an operator."
const LUCENE_SPECIAL_CHARS = /([+\-&|!(){}[\]^"~*?:\\/])/g;

/** Escapes Lucene's special/operator characters so a search term is treated as literal text. */
export function escapeLucene(term: string): string {
  return term.replace(LUCENE_SPECIAL_CHARS, '\\$1');
}

/**
 * Builds a Lucene query string that matches a term either as an EXACT
 * phrase (boosted higher, `^2`) or as a FUZZY/typo-tolerant match (`~`,
 * Lucene's fuzzy-match operator, which allows small edit-distance typos
 * like "arow" matching "arrow"). Combining both with OR in one query means
 * an exact match always ranks above a fuzzy one, but a fuzzy match is
 * still found if there's no exact hit.
 */
export function buildFuzzyOrExactQuery(term: string): string {
  const escaped = escapeLucene(term.trim().toLowerCase());
  return `"${escaped}"^2 OR ${escaped}~`;
}
