// Search mode 4 of 4, the "hybrid search" the whole project is really
// about: a user describes what they're looking for in plain language --
// what it looks like, or what they'd use it for -- without necessarily
// knowing its name, category, or exact tag.
//
// This runs THREE independent searches and merges them:
//   1. Full-text search over Tag values (catches keyword matches, e.g.
//      the query happens to contain a word that's literally one of the
//      icon's tags)
//   2. Full-text search over Icon name/description text (catches keyword
//      matches against the descriptive text itself)
//   3. Vector similarity search over icon embeddings (catches SEMANTIC
//      matches -- the query means something similar even if it shares no
//      exact words with any tag or description)
// ...then fuses the three ranked lists into one with reciprocalRankFusion
// (see rankFusion.ts for why -- Cypher is new here, so the fusion logic
// lives in plain, testable TypeScript rather than one complex Cypher query).

import neo4j, { type Driver } from 'neo4j-driver';
import { generateQueryEmbedding } from '../embeddingClient.ts';
import { escapeLucene } from './luceneQuery.ts';
import { reciprocalRankFusion } from './rankFusion.ts';
import { toIconSearchResult } from './toIconSearchResult.ts';
import type { IconSearchResult } from './types.ts';

/**
 * IMPORTANT: uses plain `escapeLucene(query)`, NOT `buildFuzzyOrExactQuery`
 * (the helper searchByTag.ts uses). `buildFuzzyOrExactQuery` wraps its
 * input as one quoted EXACT PHRASE plus one whole-string FUZZY term -- the
 * right shape for a single tag word like "airplane", but nonsensical for a
 * multi-word natural-language query: the exact-phrase clause can never
 * match (no tag literally equals a whole sentence), and Lucene's fuzzy `~`
 * operator only applies edit-distance typo tolerance to the single
 * PRECEDING token, so "flying in the sky~" only fuzzes "sky", while
 * "flying", "in", and "the" get searched as plain literal terms --
 * matching almost anything that happens to contain common words like
 * "the" or "of". Plain `escapeLucene(query)` lets Lucene's default parser
 * treat the query as an OR of each individual word instead, which is a
 * much more sensible (if still imperfect) keyword-matching behavior for a
 * whole phrase.
 */
async function searchTagsFullText(driver: Driver, query: string, candidateLimit: number): Promise<IconSearchResult[]> {
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
      LIMIT $candidateLimit
      `,
      { luceneQuery: escapeLucene(query), candidateLimit: neo4j.int(candidateLimit) },
    );
    return result.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}

async function searchIconTextFullText(driver: Driver, query: string, candidateLimit: number): Promise<IconSearchResult[]> {
  const session = driver.session();
  try {
    // No fuzzy/exact split here (unlike searchByName.ts) -- a natural-
    // language query is a whole phrase, not a single word being typed
    // carefully, so we just let Lucene tokenize and match it as-is.
    const result = await session.run(
      `
      CALL db.index.fulltext.queryNodes('iconTextIndex', $luceneQuery) YIELD node AS i, score
      MATCH (i)-[:IN_CATEGORY]->(c:Category)
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, score
      ORDER BY score DESC
      LIMIT $candidateLimit
      `,
      { luceneQuery: escapeLucene(query), candidateLimit: neo4j.int(candidateLimit) },
    );
    return result.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}

async function searchByEmbeddingSimilarity(driver: Driver, query: string, candidateLimit: number): Promise<IconSearchResult[]> {
  const session = driver.session();
  try {
    const queryVector = await generateQueryEmbedding(query);
    // `CYPHER 25` selects the Cypher language version that supports the
    // `SEARCH ... VECTOR INDEX ... SCORE AS` syntax below (the current,
    // non-deprecated way to query a vector index -- the older
    // `db.index.vector.queryNodes()` procedure still works but is
    // deprecated). This project's Neo4j install already defaults to
    // Cypher 25, but the prefix is included explicitly so this keeps
    // working even if that default ever changes.
    const result = await session.run(
      `
      CYPHER 25
      MATCH (i:Icon)
      SEARCH i IN (VECTOR INDEX iconEmbeddings FOR $queryVector LIMIT $candidateLimit) SCORE AS score
      MATCH (i)-[:IN_CATEGORY]->(c:Category)
      RETURN i.name AS name, i.filename AS filename, i.figmaName AS figmaName,
             c.name AS category, i.shortDescription AS shortDescription, score
      ORDER BY score DESC
      `,
      { queryVector, candidateLimit: neo4j.int(candidateLimit) },
    );
    return result.records.map(toIconSearchResult);
  } finally {
    await session.close();
  }
}

/**
 * Hybrid natural-language search: runs full-text (tag + icon-text) and
 * vector-similarity searches in parallel, then fuses them into one ranked
 * list. If the embedding step fails for any reason (e.g. Ollama isn't
 * running), this DEGRADES to full-text-only results instead of failing
 * the whole search -- a partially-working search is much better than a
 * broken one for something meant to run as a live, hosted service.
 */
export async function searchIconsByNaturalLanguage(driver: Driver, query: string, limit: number): Promise<IconSearchResult[]> {
  // Fetch more candidates from each individual list than we'll ultimately
  // return, since fusion needs enough overlap between lists to be
  // meaningful -- if we only fetched `limit` from each list, fusion would
  // have very little to actually combine.
  const candidateLimit = Math.max(limit * 3, 20);

  const [tagHits, textHits] = await Promise.all([
    searchTagsFullText(driver, query, candidateLimit),
    searchIconTextFullText(driver, query, candidateLimit),
  ]);

  let vectorHits: IconSearchResult[] = [];
  try {
    vectorHits = await searchByEmbeddingSimilarity(driver, query, candidateLimit);
  } catch (error) {
    console.warn('Vector search skipped (embedding or vector-index query failed):', error);
  }

  const fused = reciprocalRankFusion([tagHits, textHits, vectorHits]);
  return fused.slice(0, limit);
}
