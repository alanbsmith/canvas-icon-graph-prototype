// This is the ETL (Extract, Transform, Load) step: it reads the tagging
// results from output/tags.json and loads them into the Neo4j graph
// database, following the schema described in MAINTAINING.md:
//   - Icon nodes (one per successfully-tagged icon), including a
//     precomputed `embedding` property (see embeddingClient.ts) used for
//     semantic/similarity search
//   - Tag nodes (shared/deduplicated across icons -- e.g. one "person" Tag
//     node with many icons connected to it, not one copy per icon)
//   - Category nodes (one per category, only 11 total)
//   - (:Icon)-[:HAS_TAG]->(:Tag)
//   - (:Icon)-[:HAS_SYNONYM]->(:Tag)  (same Tag node pool as HAS_TAG)
//   - (:Icon)-[:IN_CATEGORY]->(:Category)
//
// Run with: npm run load-graph
//
// NOTE on "staging & review" (stage 3 of the overall plan): that stage
// isn't built yet, so for now this loads every icon that was successfully
// tagged (i.e. `generated` is not null) -- there's no separate human
// approval step in between yet. When stage 3 exists, this should read from
// wherever APPROVED tags end up living instead of straight from
// output/tags.json.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedTransaction, Session } from 'neo4j-driver';

import type { GeneratedTagResult, IconTaggingRecord } from '../types.ts';
import { generateDocumentEmbeddings } from '../embeddingClient.ts';
import { createNeo4jDriver } from './neo4jClient.ts';
import { ensureSchema } from './schema.ts';

const TAGS_JSON_PATH = path.join(import.meta.dirname, '..', '..', 'output', 'tags.json');

// A record whose `generated` field is known (by TypeScript, not just by
// us) to be non-null. We use this instead of scattering `record.generated!`
// (a "trust me, this isn't null" assertion) throughout the file below --
// see hasGeneratedTags() for how a plain record becomes one of these.
type TaggedIconRecord = IconTaggingRecord & { generated: GeneratedTagResult };

/**
 * A "type predicate" function: TypeScript understands that if this
 * returns `true` for some `record`, that record's `generated` field must
 * be non-null from then on -- so `records.filter(hasGeneratedTags)`
 * produces an array typed as `TaggedIconRecord[]`, not `IconTaggingRecord[]`,
 * letting every function below use `.generated.tags` directly without
 * needing a null check (or a risky `!` assertion) of its own.
 */
function hasGeneratedTags(record: IconTaggingRecord): record is TaggedIconRecord {
  return record.generated !== null;
}

/**
 * Normalizes a tag/synonym value before it becomes a Tag node's `value`
 * property. Lowercasing means "Airplane" and "airplane" always become the
 * SAME Tag node (matching the case-insensitive comparisons already used
 * when cleaning up the model's output in ollamaClient.ts) -- otherwise
 * we'd end up with duplicate Tag nodes that differ only by casing.
 * `new Set(...)` then drops any values that became identical after
 * normalizing (e.g. two tags that only differed by casing).
 */
function normalizeAndDeduplicate(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))];
}

/**
 * Builds the plain-text "document" that gets converted into a search
 * embedding for one icon (see embeddingClient.ts). This is the ONE place
 * that decides what information the similarity-search half of hybrid
 * search can actually see -- if a future search feels like it's missing
 * some obvious icon, this is the first place to check.
 *
 * Order matters a little: name/category come first as identifying
 * context, use cases last as the most free-associative field (closest to
 * how a real user might phrase what they're looking for).
 */
function buildEmbeddingText(record: TaggedIconRecord): string {
  const tagValues = normalizeAndDeduplicate(record.generated.tags);
  const synonymValues = normalizeAndDeduplicate(record.generated.synonyms);

  return [
    `Icon name: ${record.name}`,
    `Category: ${record.category}`,
    `Tags: ${tagValues.join(', ')}`,
    `Synonyms: ${synonymValues.join(', ')}`,
    `Description: ${record.generated.shortDescription}`,
    `Use cases: ${record.generated.useCases.join('; ')}`,
  ].join('\n');
}

/**
 * Replaces ALL of one icon's outgoing relationships of a given type with a
 * fresh set built from `values`, inside an already-open transaction.
 *
 * Why "delete everything, then recreate" instead of computing a precise
 * diff (add only what's new, remove only what's gone)? At this project's
 * scale (a few thousand relationships total), re-creating is cheap enough
 * that it's not worth the extra code a real diff would need -- and it's
 * easy to reason about: whatever's in `values` right now is exactly what
 * ends up connected, regardless of what was there before. (One accepted
 * side effect: a Tag/Category node that's no longer referenced by ANY icon
 * stays in the graph as an orphan rather than being cleaned up -- not
 * worth building removal logic for at this scale.)
 *
 * `relationshipType` and `targetLabel` are written directly into the query
 * string (rather than passed as `$parameters` like the values below)
 * because Cypher does NOT support parameterizing relationship types or
 * node labels -- only property VALUES can be parameters. This is safe
 * from injection here because both are restricted by TypeScript to the
 * fixed literal values used at the call sites in loadIconIntoGraph() below
 * -- there's no code path that could pass in arbitrary text.
 *
 * IMPORTANT Cypher gotcha this code has to work around: `OPTIONAL MATCH
 * (i)-[existingRelationship:...]->()` produces ONE ROW PER EXISTING
 * RELATIONSHIP, not one row per icon -- so if this icon already had, say,
 * 10 tags, we'd have 10 rows at this point, each carrying the same `i`.
 * Following that with a plain `WITH i` would carry all 10 rows forward,
 * and the `UNWIND $values` after it would then run once per (old
 * relationship x new value) pair -- a 10x cross-product of wasted (though
 * harmless, since MERGE is idempotent) work. `WITH DISTINCT i` collapses
 * those duplicate rows back down to exactly one before the UNWIND runs.
 */
async function replaceRelationships(
  tx: ManagedTransaction,
  iconName: string,
  relationshipType: 'HAS_TAG' | 'HAS_SYNONYM',
  targetLabel: 'Tag',
  values: string[],
): Promise<void> {
  await tx.run(
    `
    MATCH (i:Icon {name: $iconName})
    OPTIONAL MATCH (i)-[existingRelationship:${relationshipType}]->()
    DELETE existingRelationship
    WITH DISTINCT i
    UNWIND $values AS value
    MERGE (t:${targetLabel} {value: value})
    MERGE (i)-[:${relationshipType}]->(t)
    `,
    { iconName, values },
  );
}

/**
 * Loads one icon's full set of graph data -- its own properties, category,
 * tags, and synonyms -- as a single atomic transaction. Doing this in one
 * transaction (rather than one per Cypher statement) means this icon is
 * never left half-updated if something goes wrong partway through; it's
 * either fully updated or not updated at all.
 *
 * ("MERGE" is Cypher's find-or-create: it matches an existing node/
 * relationship if one exists, or creates it if not -- exactly the
 * "upsert" behavior this ETL step needs, since re-running after tags
 * change should update the existing icon rather than create a duplicate.
 * Docs: https://neo4j.com/docs/cypher-manual/current/clauses/merge/)
 */
async function loadIconIntoGraph(
  session: Session,
  record: TaggedIconRecord,
  embedding: number[] | null,
): Promise<void> {
  const tagValues = normalizeAndDeduplicate(record.generated.tags);
  const synonymValues = normalizeAndDeduplicate(record.generated.synonyms);

  await session.executeWrite(async (tx) => {
    await tx.run(
      `
      MERGE (i:Icon {name: $name})
      SET i.filename = $filename,
          i.figmaName = $figmaName,
          i.shortDescription = $shortDescription,
          i.useCases = $useCases,
          i.embedding = $embedding
      `,
      {
        name: record.name,
        filename: record.filename,
        figmaName: record.figmaName,
        shortDescription: record.generated.shortDescription,
        useCases: record.generated.useCases,
        // A plain JS number array -- Neo4j's driver sends this as a
        // LIST<FLOAT> automatically, which is exactly what the
        // `iconEmbeddings` vector index (see schema.ts) expects. No
        // special wrapping needed. `null` here (generateDocumentEmbeddings
        // failed for this icon) makes Cypher's `SET` REMOVE the property
        // instead of setting it -- the icon still loads and works fine
        // for name/category/tag search, it just won't show up in
        // similarity search until a future run successfully embeds it.
        embedding,
      },
    );

    // Replace the category relationship the same delete-then-recreate way
    // as tags/synonyms below, rather than only ever adding one -- so if an
    // icon's category ever changes between runs, the old (now-wrong)
    // relationship doesn't stick around alongside the new one.
    await tx.run(
      `
      MATCH (i:Icon {name: $name})
      OPTIONAL MATCH (i)-[existingCategoryRelationship:IN_CATEGORY]->()
      DELETE existingCategoryRelationship
      WITH DISTINCT i
      MERGE (c:Category {name: $category})
      MERGE (i)-[:IN_CATEGORY]->(c)
      `,
      { name: record.name, category: record.category },
    );

    await replaceRelationships(tx, record.name, 'HAS_TAG', 'Tag', tagValues);
    await replaceRelationships(tx, record.name, 'HAS_SYNONYM', 'Tag', synonymValues);
  });
}

async function main(): Promise<void> {
  const allRecords: IconTaggingRecord[] = JSON.parse(readFileSync(TAGS_JSON_PATH, 'utf-8'));
  const taggedRecords = allRecords.filter(hasGeneratedTags);

  console.log(
    `Loading ${taggedRecords.length} of ${allRecords.length} icons into Neo4j ` +
      `(${allRecords.length - taggedRecords.length} skipped -- not successfully tagged yet).`,
  );

  // Embeddings are recomputed for every icon on every run (not just new
  // ones) -- same "replace, don't diff" philosophy as replaceRelationships()
  // above. At this scale, re-embedding everything locally costs seconds,
  // not the hours the vision-tagging step costs, so there's no real
  // upside to the extra bookkeeping a "skip if already embedded" check
  // would need.
  console.log(`Generating embeddings for ${taggedRecords.length} icons...`);
  const embeddings = await generateDocumentEmbeddings(taggedRecords.map(buildEmbeddingText));
  const embeddingByIconName = new Map(taggedRecords.map((record, index) => [record.name, embeddings[index]]));

  const driver = createNeo4jDriver();
  try {
    await ensureSchema(driver);

    const session = driver.session();
    try {
      for (const [index, record] of taggedRecords.entries()) {
        console.log(`[${index + 1}/${taggedRecords.length}] ${record.name}`);

        // `undefined` (the key is missing entirely) would mean a real
        // programming bug -- every taggedRecord was embedded above, in
        // the same order -- so that case still fails loudly. `null` (the
        // key IS present, but generateDocumentEmbeddings recorded a
        // failure for it) is a legitimate, expected outcome we handle
        // gracefully: log it and load the icon anyway, just without a
        // vector embedding for now.
        if (!embeddingByIconName.has(record.name)) {
          throw new Error(`No embedding entry recorded for icon "${record.name}"`);
        }
        const embedding = embeddingByIconName.get(record.name) ?? null;
        if (embedding === null) {
          console.warn(`  Loading "${record.name}" without an embedding (generation failed for it earlier).`);
        }

        await loadIconIntoGraph(session, record, embedding);
      }
    } finally {
      await session.close();
    }

    console.log(`\nDone: ${taggedRecords.length} icons loaded into Neo4j.`);
    console.log('Browse the result at http://localhost:7474');
  } finally {
    await driver.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
