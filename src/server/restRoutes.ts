// The plain REST/JSON API -- the interface a normal website (like the
// Canvas docs site's search box) calls, since a browser can't speak MCP's
// protocol. Every route here calls the exact same src/search/*.ts
// functions the MCP tools call (see mcpServer.ts) -- this file has no
// search LOGIC of its own, only HTTP request/response plumbing.

import type { Express, Request, Response } from 'express';
import type { Driver } from 'neo4j-driver';

import { searchIconsByName } from '../search/searchByName.ts';
import { searchIconsByCategory } from '../search/searchByCategory.ts';
import { searchIconsByTag } from '../search/searchByTag.ts';
import { searchIconsByNaturalLanguage } from '../search/searchByNaturalLanguage.ts';
import { getIconDetails } from '../search/getIconDetails.ts';
import { InvalidCategoryError } from '../search/types.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Reads and clamps the `limit` query parameter. Query-string values always
 * arrive as strings (or undefined), unlike MCP's already-typed JSON
 * arguments -- this is the one real difference between validating input
 * for the two interfaces mentioned in the project's search-architecture
 * plan. `Math.min`/`Math.max` clamp a bad or missing value into range
 * rather than rejecting the request outright.
 */
function parseLimit(req: Request): number {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

/**
 * Wraps a route handler so any error it throws becomes a sensible HTTP
 * response instead of an unhandled rejection: `InvalidCategoryError`
 * (a known, expected failure) becomes a 400 with an explanatory message;
 * anything else becomes a generic 500 (with the real error only logged
 * server-side, never sent to the client, since it might contain internal
 * details that shouldn't be exposed publicly).
 */
function handleErrors(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof InvalidCategoryError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Search request failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/** Registers every /api/search/* and /api/icons/* route on the given Express app. */
export function registerRestRoutes(app: Express, driver: Driver): void {
  app.get(
    '/api/search/name',
    handleErrors(async (req, res) => {
      const query = String(req.query.query ?? '');
      const results = await searchIconsByName(driver, query, parseLimit(req));
      res.json({ results });
    }),
  );

  app.get(
    '/api/search/category',
    handleErrors(async (req, res) => {
      const category = String(req.query.category ?? '');
      const results = await searchIconsByCategory(driver, category, parseLimit(req));
      res.json({ results });
    }),
  );

  app.get(
    '/api/search/tag',
    handleErrors(async (req, res) => {
      const tag = String(req.query.tag ?? '');
      const results = await searchIconsByTag(driver, tag, parseLimit(req));
      res.json({ results });
    }),
  );

  app.get(
    '/api/search/natural-language',
    handleErrors(async (req, res) => {
      const query = String(req.query.query ?? '');
      const results = await searchIconsByNaturalLanguage(driver, query, parseLimit(req));
      res.json({ results });
    }),
  );

  app.get(
    '/api/icons/:name',
    handleErrors(async (req, res) => {
      // Express types a route param as `string | string[]` (some route
      // patterns can capture multiple segments); `:name` here only ever
      // captures one, but `String(...)` makes that explicit either way.
      const name = String(req.params.name);
      const icon = await getIconDetails(driver, name);
      if (!icon) {
        res.status(404).json({ error: `No icon found with name "${name}"` });
        return;
      }
      res.json({ icon });
    }),
  );
}
