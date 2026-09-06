// This file defines the "shapes" of data that flow through the pipeline:
// 1. What an icon's existing metadata looks like (comes from the npm package).
// 2. What we ask the vision model to generate for each icon.
// 3. What we save to disk so a human can review the results.
//
// We use a library called "zod" (https://zod.dev/) for #2. Zod lets us describe
// a shape once and get two things from that single description:
//   a) A TypeScript type (compile-time checking, e.g. autocomplete in your editor)
//   b) A runtime validator (checks that data ACTUALLY matches the shape while the
//      program is running -- this matters because the vision model's output is
//      just text, and text can be malformed even when we ask nicely for JSON).

import { z } from 'zod';

// --------------------------------------------------------------------------
// Helper: remove duplicate values from a list the model generated
// --------------------------------------------------------------------------
// In testing, the vision model would occasionally repeat the same value
// several times instead of generating a real list of distinct ones (e.g.
// returning ["hold", "hold", "hold", ...] as "synonyms" for a pause icon).
// That still counts as valid JSON matching our shape, so zod's normal
// validation wouldn't catch it -- we need to actively clean it up.
//
// We compare values case-INsensitively (so "Hold" and "hold" count as the
// same duplicate, not two different tags), but keep the ORIGINAL casing of
// whichever copy we saw first, in its original order.
//
// Exported (not just used internally) because ollamaClient.ts re-runs this
// same dedupe after ALSO stripping out "icon"-flavored and name-duplicate
// tags -- that stripping can turn previously-distinct tags into duplicates
// of each other (e.g. "person icon" and "person" both become "person"),
// so it needs to dedupe again afterwards.
export function dedupeCaseInsensitive(items: string[]): string[] {
  const seenLowercased = new Set<string>();
  const uniqueItems: string[] = [];

  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!seenLowercased.has(key)) {
      seenLowercased.add(key);
      uniqueItems.push(item);
    }
  }

  return uniqueItems;
}

// --------------------------------------------------------------------------
// 1. Existing icon metadata, as shipped by @workday/canvas-system-icons-web
// --------------------------------------------------------------------------
// This matches the exact JSON shape found in the package's
// dist/metadata/system.metadata.json file. Every icon entry has exactly
// these 8 fields (verified by inspecting the real file before writing this).
//
// Note: `author` and `description` are always empty strings in this version
// of the package -- they exist in the schema but aren't populated. We still
// declare them here for completeness / type accuracy, we just don't use them.
export interface IconMetadataEntry {
  author: string;
  category: string;
  description: string;
  figmaName: string;
  filename: string;
  maintainer: string;
  name: string;
  tags: string[];
}

// --------------------------------------------------------------------------
// 2. What we ask the vision model to generate, as a zod "schema"
// --------------------------------------------------------------------------
// `z.object({...})` describes a JSON object with named fields.
// `z.array(z.string())` describes "an array where every item is a string".
// `.min(n)` / `.max(n)` enforce how many items the array must have -- this
// keeps the model from returning something too sparse (unhelpful) or wildly
// long (probably rambling instead of concise tags).
//
// Docs: https://zod.dev/api#objects and https://zod.dev/api#arrays
//
// IMPORTANT: this is intentionally split into TWO schemas, not one:
//
//   - `GeneratedTagResponseShape` (below) has NO transforms. We hand this
//     one to Ollama (via `z.toJSONSchema(...)` in ollamaClient.ts) so it
//     knows what JSON shape to produce. JSON Schema is a plain, static
//     description of a shape -- it has no way to express "and then run
//     this JavaScript function on the result" -- so zod THROWS if you try
//     to convert a schema containing a `.transform()` into JSON Schema.
//     (We learned this the hard way: adding a dedupe `.transform()`
//     directly to this schema broke every single request before it even
//     reached the model.)
//
//   - `GeneratedTagSchema` (further below) builds on the shape above by
//     adding a `.transform()` that removes duplicate values -- but it's
//     only ever used for `.parse()`-ing the model's response AFTER we get
//     it back, never passed to `z.toJSONSchema()`.
export const GeneratedTagResponseShape = z.object({
  // Search-style keywords describing what's visually in the icon
  // (objects, actions, shapes) -- e.g. ["arrow", "download", "cloud"].
  tags: z.array(z.string()).min(5).max(20),

  // Alternative words/phrases a person might type when searching in plain
  // language, e.g. "trash can" as a synonym for a "delete" icon.
  synonyms: z.array(z.string()).min(1).max(15),

  // Short phrases describing when a product designer would reach for this
  // icon, e.g. "confirm a destructive action".
  useCases: z.array(z.string()).min(1).max(10),

  // One plain-language sentence describing what the icon looks like.
  shortDescription: z.string().min(1).max(300),
});

// The schema we actually validate the model's response against (see
// ollamaClient.ts). It starts from the exact shape above -- so the
// min/max item-count checks still run against what the model ACTUALLY
// returned -- and then, only once that passes, applies
// `dedupeCaseInsensitive` to the three list fields. Docs on transforms:
// https://zod.dev/api#transforms
export const GeneratedTagSchema = GeneratedTagResponseShape.transform((data) => ({
  ...data,
  tags: dedupeCaseInsensitive(data.tags),
  synonyms: dedupeCaseInsensitive(data.synonyms),
  useCases: dedupeCaseInsensitive(data.useCases),
}));

// `z.infer<typeof X>` asks zod to derive a plain TypeScript type from the
// schema above, so we don't have to write the same shape out twice by hand.
export type GeneratedTagResult = z.infer<typeof GeneratedTagSchema>;

// --------------------------------------------------------------------------
// 3. One row of our output file (output/tags.json) -- one per icon
// --------------------------------------------------------------------------
// This combines the icon's existing metadata with whatever the model
// generated, PLUS some bookkeeping fields that make the results easier to
// debug later (what model produced this? when? did parsing fail?).
export interface IconTaggingRecord {
  name: string;
  filename: string;
  category: string;
  figmaName: string;
  existingTags: string[];

  // `null` when the model's response could not be validated against
  // GeneratedTagSchema above (e.g. it returned malformed JSON, or JSON that
  // doesn't match our required shape). We keep the record either way so
  // failures are visible in the output instead of silently vanishing.
  generated: GeneratedTagResult | null;

  // The exact, unmodified text the model returned. Always kept (even on
  // success) so we can debug prompt/schema issues by comparing what we
  // asked for against exactly what came back.
  rawModelResponse: string;

  // Path to the rasterized PNG we generated for this icon, relative to the
  // output/ directory (e.g. "images/accessibility.png"), used by the HTML
  // report to display the icon next to its tags.
  imagePath: string;

  modelName: string;

  // ISO 8601 timestamp string, e.g. "2026-09-05T20:14:03.000Z".
  generatedAt: string;

  // Present only when `generated` is null -- a human-readable explanation
  // of what went wrong (e.g. the zod validation error message).
  validationError?: string;
}
