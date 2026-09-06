// This file turns plain text into "embeddings" -- lists of numbers that
// capture the MEANING of the text, so that texts with similar meaning end
// up as similar-looking lists of numbers. This is what powers the
// "semantic similarity" half of hybrid search: instead of only matching
// exact words, we can find icons whose description is CONCEPTUALLY close
// to what a user typed, even if they don't share any exact words.
//
// The model that does this conversion runs locally via Ollama (same setup
// already used for vision tagging in ollamaClient.ts), specifically
// "nomic-embed-text" -- a small (274MB), fast, general-purpose English
// text-embedding model. Docs: https://ollama.com/library/nomic-embed-text

import { Ollama } from 'ollama';

const EMBEDDING_MODEL_NAME = 'nomic-embed-text:v1.5';

// How many texts we send to Ollama in a single request when embedding a
// big batch (e.g. all ~822 icons at once). Chunking avoids sending one
// enormous request payload; 50 is a reasonably-sized batch that finishes
// quickly without needing to think much about it.
const EMBEDDING_BATCH_SIZE = 50;

// The length of the number list nomic-embed-text produces for every piece
// of text. This has to match, EXACTLY, the `vector.dimensions` value used
// when creating the Neo4j vector index (see graph/schema.ts) -- Neo4j
// rejects (or silently mismatches) vectors that don't match the index's
// configured size. Exporting this constant means schema.ts can import it
// instead of us having to keep two files' numbers in sync by hand.
export const EMBEDDING_DIMENSIONS = 768;

const ollama = new Ollama();

/**
 * Splits an array into smaller arrays ("chunks") of at most `size` items
 * each. E.g. chunk([1,2,3,4,5], 2) -> [[1,2], [3,4], [5]].
 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// IMPORTANT, easy to miss: nomic-embed-text's own model card says it needs
// a short task-instruction PREFIX on every piece of text for good results
// -- "search_document: " for text being stored/indexed, and
// "search_query: " for text a user is searching WITH. Without these
// prefixes, the model still produces embeddings, but retrieval quality is
// measurably worse (the model was specifically trained to expect them).
// Reference: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
// Both functions below bake the correct prefix in, so no other file in
// this project has to remember to add it.

/**
 * Generates embeddings for a batch of icon-description texts, meant to be
 * STORED (e.g. as each Icon node's `embedding` property). Returns one
 * entry per input string, in the same order.
 *
 * A `null` entry means embedding that ONE BATCH failed (e.g. Ollama
 * briefly unreachable) -- rather than letting one bad batch abort the
 * entire call (which, for a caller processing hundreds of icons, would
 * mean throwing away every icon's work, not just the ones in the failed
 * batch), we log a warning and let the caller decide how to handle a
 * missing embedding (e.g. load the icon anyway, just without one yet).
 * This mirrors the same graceful-degradation approach used for live
 * search queries in searchByNaturalLanguage.ts.
 */
export async function generateDocumentEmbeddings(texts: string[]): Promise<Array<number[] | null>> {
  const batches = chunk(texts, EMBEDDING_BATCH_SIZE);
  const allEmbeddings: Array<number[] | null> = [];

  for (const batch of batches) {
    try {
      const { embeddings } = await ollama.embed({
        model: EMBEDDING_MODEL_NAME,
        input: batch.map((text) => `search_document: ${text}`),
      });
      allEmbeddings.push(...embeddings);
    } catch (error) {
      console.warn(`Embedding batch of ${batch.length} text(s) failed, continuing without them:`, error);
      allEmbeddings.push(...batch.map(() => null));
    }
  }

  return allEmbeddings;
}

/**
 * Generates one embedding for a live user search query, so it can be
 * compared against the stored document embeddings above to find the
 * closest matches.
 */
export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const { embeddings } = await ollama.embed({
    model: EMBEDDING_MODEL_NAME,
    input: `search_query: ${text}`,
  });
  return embeddings[0];
}
