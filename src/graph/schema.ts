// This file sets up the Neo4j "schema" -- the uniqueness constraints and
// search indexes everything else in this project relies on.
//
// Three kinds of schema object, each backing a different part of search:
//   1. Uniqueness constraints (Icon/Tag/Category) -- correctness for the
//      ETL's upsert logic, and fast exact-match lookups.
//   2. A vector index on Icon.embedding -- powers semantic/similarity
//      search (natural-language queries).
//   3. Full-text indexes on Tag.value and Icon's name/description fields
//      -- powers keyword search with typo tolerance (fuzzy matching).
//
// Docs: https://neo4j.com/docs/cypher-manual/current/constraints/ and
// https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/

import type { Driver } from 'neo4j-driver';
import { EMBEDDING_DIMENSIONS } from '../embeddingClient.ts';

// `IF NOT EXISTS` makes every statement in this file safe to run every
// time the ETL script runs -- the first run creates each schema object,
// every run after that is a harmless no-op rather than an error.
const CONSTRAINT_STATEMENTS = [
  'CREATE CONSTRAINT icon_name_unique IF NOT EXISTS FOR (i:Icon) REQUIRE i.name IS UNIQUE',
  'CREATE CONSTRAINT tag_value_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.value IS UNIQUE',
  'CREATE CONSTRAINT category_name_unique IF NOT EXISTS FOR (c:Category) REQUIRE c.name IS UNIQUE',
];

// A vector index tells Neo4j "index this property as a list of numbers,
// and let me search it by NEAREST NEIGHBOR (which vectors are most
// similar to a given vector)" -- this is what powers similarity search.
// `vector.dimensions` MUST match the length of every embedding we ever
// store (see EMBEDDING_DIMENSIONS in embeddingClient.ts); `cosine` is the
// standard similarity measure for text embeddings like nomic-embed-text's.
const VECTOR_INDEX_STATEMENT = `
  CREATE VECTOR INDEX iconEmbeddings IF NOT EXISTS
  FOR (i:Icon) ON i.embedding
  OPTIONS { indexConfig: {
    \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS},
    \`vector.similarity_function\`: 'cosine'
  }}
`;

// Full-text indexes are powered by Lucene (a text-search engine) under the
// hood, and support things a plain equality match can't: typo-tolerant
// "fuzzy" matching, wildcards, and relevance scoring. One index can cover
// multiple properties (and even multiple node labels) at once -- a node
// matches if it has AT LEAST ONE of the indexed properties containing the
// search term, not all of them.
//
// `fulltext.analyzer: 'english'` is NOT the default and has to be set
// explicitly -- Neo4j's actual default analyzer is confusingly named
// "standard-no-stop-words", which (despite the name) filters NO stop
// words at all. Without this option, a natural-language query like
// "something for flying in the sky" would score common words like "the"
// and "of" as real matches (confirmed by testing directly: it surfaced
// unrelated tags like "day of the month" ahead of genuinely relevant
// ones). The 'english' analyzer adds real stop-word filtering plus light
// stemming, which is what we actually want for matching English search
// phrases against English tag/description text.
// Reference: https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/full-text-indexes/#analyzers
const FULLTEXT_ANALYZER_OPTIONS = `OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'english' } }`;
const FULLTEXT_INDEX_STATEMENTS = [
  // Backs tag search (searchByTag.ts) and the tag-matching half of
  // natural-language search.
  `CREATE FULLTEXT INDEX tagValueIndex IF NOT EXISTS FOR (t:Tag) ON EACH [t.value] ${FULLTEXT_ANALYZER_OPTIONS}`,
  // Backs the fuzzy fallback in name search (searchByName.ts) and the
  // descriptive-text half of natural-language search.
  `CREATE FULLTEXT INDEX iconTextIndex IF NOT EXISTS FOR (i:Icon) ON EACH [i.name, i.figmaName, i.shortDescription] ${FULLTEXT_ANALYZER_OPTIONS}`,
];

const ALL_INDEX_NAMES = ['iconEmbeddings', 'tagValueIndex', 'iconTextIndex'];

/**
 * A freshly created index isn't necessarily searchable the instant `CREATE
 * INDEX` returns -- Neo4j builds it in the background and it briefly
 * reports itself as `POPULATING` before flipping to `ONLINE`. At this
 * project's scale (well under 2000 nodes total) that population is
 * essentially instant, but we check anyway rather than assume timing that
 * happens to work today keeps working forever. Polls every 200ms for up
 * to 5 seconds, then gives up with a warning (rather than hanging forever
 * or crashing) -- whatever queries the index afterward will just see
 * partial/no results until it finishes, not an error.
 */
async function waitForIndexesOnline(driver: Driver): Promise<void> {
  const session = driver.session();
  const maxAttempts = 25; // 25 * 200ms = 5 seconds
  const pollIntervalMs = 200;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await session.run(
        `SHOW INDEXES YIELD name, state WHERE name IN $names AND state <> 'ONLINE' RETURN count(*) AS notOnlineCount`,
        { names: ALL_INDEX_NAMES },
      );
      // Neo4j returns whole numbers as its own `Integer` type (to safely
      // represent values bigger than JavaScript's native numbers can
      // hold), not a plain JS number -- `.toNumber()` converts it. Safe
      // here since we're counting at most 3 indexes.
      const notOnlineCount = result.records[0].get('notOnlineCount').toNumber();
      if (notOnlineCount === 0) return;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    console.warn(
      `Some indexes were not ONLINE after ${(maxAttempts * pollIntervalMs) / 1000}s -- ` +
        `queries against them may return incomplete results until they finish populating.`,
    );
  } finally {
    await session.close();
  }
}

/** Creates every constraint and index this project's search relies on, if they don't already exist. */
export async function ensureSchema(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    for (const statement of CONSTRAINT_STATEMENTS) {
      await session.run(statement);
    }
    await session.run(VECTOR_INDEX_STATEMENT);
    for (const statement of FULLTEXT_INDEX_STATEMENTS) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }

  await waitForIndexesOnline(driver);
}
