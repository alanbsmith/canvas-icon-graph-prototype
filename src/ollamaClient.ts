// This file talks to the vision-language model (running locally via Ollama)
// for a single icon: it builds a text prompt, sends the prompt + the icon's
// image, and validates the JSON that comes back.
//
// Ollama docs:
//   - Overview: https://docs.ollama.com/
//   - Structured outputs (forcing JSON responses): https://docs.ollama.com/capabilities/structured-outputs
//   - JS/TS client library on npm: https://www.npmjs.com/package/ollama

import { Ollama } from 'ollama';
import { z } from 'zod';
import {
  dedupeCaseInsensitive,
  GeneratedTagResponseShape,
  GeneratedTagSchema,
  type GeneratedTagResult,
  type IconMetadataEntry,
} from './types.ts';

// The model we pulled with `ollama pull qwen2.5vl:7b`. Ollama identifies
// models by this "name:size" style tag.
const MODEL_NAME = 'qwen2.5vl:7b';

// The default client talks to Ollama's local server at
// http://localhost:11434 (started with `ollama serve` / `brew services
// start ollama`) -- no configuration needed for a local setup like ours.
const ollama = new Ollama();

/**
 * Builds the text prompt sent alongside the icon's image.
 *
 * We give the model the icon's EXISTING metadata (name, category, current
 * tags) as background context, but explicitly tell it to trust what it
 * actually sees in the image over that metadata -- the whole point of this
 * project is that the existing tags are sparse/imprecise "best guesses",
 * so we don't want the model just echoing them back without really looking
 * at the picture.
 */
function buildPrompt(icon: IconMetadataEntry): string {
  return `You are helping build a natural-language search index for a UI icon library.
You are shown one monochrome icon (a dark shape on a white background, originally designed at 24x24 pixels, upscaled here for clarity).

Existing metadata for this icon (may be sparse or imprecise -- trust what you actually SEE in the image first):
- Internal name: "${icon.name}"
- Figma layer name: "${icon.figmaName}"
- Category: "${icon.category}"
- Existing tags: ${icon.tags.length > 0 ? icon.tags.join(', ') : '(none)'}

Look closely at the shapes, objects, and symbols actually drawn in the image, then return a JSON object with:
- "tags": 8-15 concise search tags describing what is visually depicted (objects, actions, shapes). Reuse existing tags only if they're still accurate; add new ones you observe.
- "synonyms": alternative words/phrases a person might type when searching in plain language (e.g. "download arrow", "trash can").
- "useCases": 2-5 short phrases describing when a product designer would use this icon.
- "shortDescription": one plain-language sentence describing the icon's visual appearance.

Every value within a single list must be distinct -- do not repeat the same word or phrase more than once in "tags", "synonyms", or "useCases". Do not append the word "icon" to a tag or synonym (write "person", not "person icon") -- every entry in these lists already IS an icon tag, so the word adds nothing. Do not append "shape", "silhouette", or "outline" to a tag or synonym either (write "airplane", not "airplane silhouette") -- nearly every icon in this library is a flat monochrome shape/outline, so that qualifier doesn't help distinguish this one. Do not use this icon's own internal name ("${icon.name}") or Figma layer name ("${icon.figmaName}") as a tag or synonym either -- searching by an icon's own name is handled separately, so repeating it here doesn't add a new way to find it. Avoid listing several near-identical phrasings of the same concept back to back (e.g. do NOT include "human figure", "human shape", "human outline", and "human silhouette" all together) -- pick the single best phrasing for each distinct concept instead of restating it with minor wording changes.

Respond with JSON only, matching the required schema exactly.`;
}

// --------------------------------------------------------------------------
// Cleanup: strip "icon"-flavored filler and name-duplicate tags
// --------------------------------------------------------------------------
// Even with the prompt instruction above, the model sometimes still
// produces tags like "person icon" (redundant -- everything in this list
// is already an icon tag) or tags that just repeat the icon's own name
// (redundant -- name-based lookup is handled separately, outside of tag
// search). This section cleans that up in code as a second line of
// defense, since we can't fully rely on the model following instructions.

/**
 * Matches the standalone word "icon", case-insensitively, wherever it
 * appears in a tag -- e.g. it matches the "icon" in "person icon", but NOT
 * the "icon" inside a longer word like "iconic".
 *
 * `\b` means "word boundary" (the edge between a word character and a
 * non-word character/start-or-end of string) -- it's what keeps this from
 * matching inside other words. The trailing `gi` flags mean "replace every
 * match in the string" (g) and "ignore uppercase/lowercase" (i).
 * Reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions
 */
const ICON_WORD_PATTERN = /\bicon\b/gi;

/**
 * Matches "shape", "silhouette", or "outline" ONLY when one of those words
 * is the LAST word of a tag -- e.g. it matches in "human shape" and
 * "airplane silhouette" (removing the word, and the space before it), but
 * would NOT match "outline" in the middle of some other phrase.
 *
 * These three words describe how an icon is DRAWN (a flat, monochrome
 * rendering style) rather than what it depicts -- and since nearly every
 * icon in this whole library is a flat shape/outline in that sense, the
 * qualifier doesn't help distinguish one icon from another. Someone
 * searching this library would type "airplane", not "airplane
 * silhouette" -- so we strip the qualifier and keep the more useful base
 * word ("airplane silhouette" -> "airplane").
 *
 * `\s*` (optional whitespace) + `\b` (word boundary) + the word choices +
 * `$` (anchors the match to the very END of the string) is what limits
 * this to a trailing qualifier rather than matching anywhere in the tag.
 * Reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions
 */
const TRAILING_STYLE_WORD_PATTERN = /\s*\b(?:shape|silhouette|outline)\b$/i;

/**
 * Builds the set of strings that should be treated as "this icon's own
 * name" for the purposes of filtering out redundant tags -- the internal
 * name as-is (e.g. "arrow-arc"), the same name with dashes turned into
 * spaces (e.g. "arrow arc", in case the model writes it that way), and the
 * Figma layer name (e.g. "Arrow Arc"). All compared lowercase/trimmed.
 */
function buildIconNameVariants(icon: IconMetadataEntry): Set<string> {
  const variants = new Set<string>();
  variants.add(icon.name.trim().toLowerCase());
  variants.add(icon.name.replace(/-/g, ' ').trim().toLowerCase());
  variants.add(icon.figmaName.trim().toLowerCase());
  return variants;
}

/**
 * Cleans up one list of tags/synonyms generated for a specific icon:
 *   1. Removes the standalone word "icon" from every entry (e.g. "person
 *      icon" becomes "person"), and removes a trailing "shape" /
 *      "silhouette" / "outline" qualifier the same way (e.g. "human
 *      shape" becomes "human").
 *   2. Drops any entry that's now empty, or that matches one of the
 *      icon's own name variants (see buildIconNameVariants above).
 *   3. Runs dedupeCaseInsensitive() again, since step 1 can turn
 *      previously-different entries into duplicates of each other -- e.g.
 *      "human shape", "human silhouette", and "human outline" all
 *      collapse down to the same word, "human".
 *
 * NOTE: we strip the QUALIFIER WORD and keep the base word, rather than
 * deleting the whole tag outright. That matters in practice: in testing,
 * some icons had NO bare form of a word at all -- e.g. the airplane icon's
 * generated tags included "airplane silhouette" and "airplane shape", but
 * never plain "airplane" on its own. Deleting those tags outright would
 * have removed "airplane" as a search term for the airplane icon
 * entirely; stripping just the qualifier keeps it.
 */
/**
 * Strips EVERY trailing "shape"/"silhouette"/"outline" qualifier off the
 * end of a tag, not just one -- a tag like "human outline shape" has two
 * of them stacked, and a single `.replace()` call only removes the
 * outermost ("shape"), leaving "human outline" still qualified. Looping
 * until nothing more matches handles any number of stacked qualifiers.
 */
function stripAllTrailingStyleWords(text: string): string {
  let result = text;
  while (TRAILING_STYLE_WORD_PATTERN.test(result)) {
    result = result.replace(TRAILING_STYLE_WORD_PATTERN, '');
  }
  return result;
}

function removeRedundantTags(items: string[], icon: IconMetadataEntry): string[] {
  const nameVariants = buildIconNameVariants(icon);

  const cleanedItems = items
    .map((item) =>
      stripAllTrailingStyleWords(item.replace(ICON_WORD_PATTERN, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((item) => item.length > 0 && !nameVariants.has(item.toLowerCase()));

  return dedupeCaseInsensitive(cleanedItems);
}

/** What generateTagsForIcon() hands back to the caller in run.ts. */
export interface TaggingOutcome {
  generated: GeneratedTagResult | null;
  rawModelResponse: string;
  validationError?: string;
}

/**
 * Sends one icon (image + grounding metadata) to the vision model and
 * returns its generated tags.
 *
 * @param icon - the icon's existing metadata (used for prompt grounding).
 * @param pngBuffer - the rasterized icon image, as produced by
 *   prepareImage.ts's rasterizeSvgToPng().
 */
export async function generateTagsForIcon(
  icon: IconMetadataEntry,
  pngBuffer: Buffer,
): Promise<TaggingOutcome> {
  const response = await ollama.chat({
    model: MODEL_NAME,
    stream: false,
    messages: [
      {
        role: 'user',
        content: buildPrompt(icon),
        // Ollama's multimodal chat API accepts images as an array of
        // base64-encoded strings attached to a message.
        images: [pngBuffer.toString('base64')],
      },
    ],
    // `format` tells Ollama to constrain the model's output to match this
    // JSON Schema. `z.toJSONSchema(...)` converts our zod schema (from
    // types.ts) into the JSON Schema format Ollama expects, so we only
    // have to describe the shape once. We deliberately use
    // `GeneratedTagResponseShape` here, NOT `GeneratedTagSchema` -- the
    // latter has a `.transform()` attached (for deduping, see types.ts),
    // and `z.toJSONSchema()` throws if the schema contains a transform
    // (JSON Schema can describe a shape, but not "then run this function").
    // Docs: https://docs.ollama.com/capabilities/structured-outputs
    format: z.toJSONSchema(GeneratedTagResponseShape),
    // Low temperature = more consistent, literal output. This is a
    // labeling/extraction task, not creative writing, so we want the model
    // to stick closely to what it observes rather than getting inventive.
    options: { temperature: 0.2 },
  });

  const rawModelResponse = response.message.content;

  // IMPORTANT: even though we asked Ollama to constrain the output via
  // `format` above, that constraint isn't always perfectly respected in
  // practice (this is a known, documented limitation -- see
  // https://github.com/ollama/ollama/issues/8063). So we still parse the
  // response as JSON and validate it against our schema ourselves, and
  // handle the case where it doesn't match instead of assuming success.
  try {
    const parsedJson = JSON.parse(rawModelResponse);
    const parsed = GeneratedTagSchema.parse(parsedJson);

    // Apply the "icon"-word and name-duplicate cleanup (see above) to the
    // two keyword-style lists. We deliberately leave `useCases` untouched
    // -- those are full sentences (e.g. "confirm a destructive action"),
    // and blindly stripping the word "icon" out of a sentence could mangle
    // a legitimate phrase like "app icon in the toolbar".
    const generated: GeneratedTagResult = {
      ...parsed,
      tags: removeRedundantTags(parsed.tags, icon),
      synonyms: removeRedundantTags(parsed.synonyms, icon),
    };

    return { generated, rawModelResponse };
  } catch (error) {
    return {
      generated: null,
      rawModelResponse,
      validationError: error instanceof Error ? error.message : String(error),
    };
  }
}
