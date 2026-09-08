// Mirrors IconSearchResult from ../../src/search/types.ts -- this is what
// the search server's REST API returns. Kept as a small, separate copy
// here (rather than importing across the project boundary) since this
// demo app has its own build/dependency setup (Vite) and isn't part of
// the main TypeScript project.
export interface IconSearchResult {
  name: string;
  filename: string;
  figmaName: string;
  category: string;
  shortDescription: string;
  score: number;
  matchedOn?: string;
}
