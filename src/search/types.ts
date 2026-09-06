// Shared data shapes for every search mode (name, category, tag, natural
// language). Following the same convention as ../types.ts: define a zod
// schema first, then derive the plain TypeScript type from it with
// `z.infer` -- that way the MCP server (src/server/mcpServer.ts) can reuse
// this exact schema as a tool's `outputSchema` with no duplication.

import { z } from 'zod';

export const IconSearchResultSchema = z.object({
  name: z.string(),
  filename: z.string(),
  figmaName: z.string(),
  category: z.string(),
  shortDescription: z.string(),
  // A relevance score. IMPORTANT: this is only meaningful for COMPARING
  // results returned by the SAME search call -- a score of 0.8 from a
  // category search and a score of 0.8 from a natural-language search
  // don't mean the same thing (different search modes compute scores in
  // completely different, incompatible ways), so never compare scores
  // across two separate search calls.
  score: z.number(),
  // Optional debugging/UX hint about WHY a result matched, e.g. "tag",
  // "synonym", "vector" -- not every search mode sets this.
  matchedOn: z.string().optional(),
});
export type IconSearchResult = z.infer<typeof IconSearchResultSchema>;

// The 11 categories that exist in the icon library today, verified
// directly against the live graph (`MATCH (c:Category) RETURN c.name`).
// Used to validate category-search input up front, and to give AI
// assistants calling the MCP tool a proper enum (autocomplete/validation)
// instead of a free-text field that's easy to typo.
export const CANONICAL_CATEGORIES = [
  'Audio Visual',
  'Chart Visuals',
  'Core',
  'Data Stream',
  'Editor',
  'Files & Docs',
  'Mobile App',
  'Navigation',
  'Notification',
  'Objects',
  'People',
] as const;
export type Category = (typeof CANONICAL_CATEGORIES)[number];

/** Thrown by searchIconsByCategory() when given a category that doesn't exist. */
export class InvalidCategoryError extends Error {
  constructor(public readonly given: string) {
    super(`"${given}" is not a known category. Valid categories: ${CANONICAL_CATEGORIES.join(', ')}`);
    this.name = 'InvalidCategoryError';
  }
}
