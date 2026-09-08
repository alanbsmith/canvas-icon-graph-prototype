import type { IconSearchResult } from './types';

// Set in .env (VITE_SEARCH_API_BASE) -- Vite only exposes env vars prefixed
// with VITE_ to browser code, as a safety measure against accidentally
// shipping server-side secrets to the client.
const API_BASE = import.meta.env.VITE_SEARCH_API_BASE as string;

/**
 * Calls the search server's natural-language search endpoint -- the same
 * REST route a real website's search box would call (see
 * ../../src/server/restRoutes.ts). This is the ONE search mode this demo
 * uses, on purpose: it's the mode that can find an icon from a plain-
 * language description, which is what makes it worth comparing against
 * today's keyword-only search.
 */
export async function searchIconsByNaturalLanguage(query: string): Promise<IconSearchResult[]> {
  const url = `${API_BASE}/api/search/natural-language?query=${encodeURIComponent(query)}&limit=12`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { results: IconSearchResult[] };
  return data.results;
}

/** Builds the URL for an icon's rasterized PNG, served by the search server (see server/index.ts). */
export function iconImageUrl(iconName: string): string {
  return `${API_BASE}/images/${iconName}.png`;
}
