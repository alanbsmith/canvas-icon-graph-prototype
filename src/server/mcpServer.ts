// Builds the MCP (Model Context Protocol) server: the interface that lets
// AI assistants (Claude Code, Cursor, etc.) call this project's icon
// search as a set of named "tools". Every tool handler below just calls
// straight into src/search/*.ts -- this file has no search LOGIC of its
// own, only the thin wrapping needed to expose that logic as MCP tools.
// Docs: https://modelcontextprotocol.io/

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Driver } from 'neo4j-driver';

import { searchIconsByName } from '../search/searchByName.ts';
import { searchIconsByCategory } from '../search/searchByCategory.ts';
import { searchIconsByTag } from '../search/searchByTag.ts';
import { searchIconsByNaturalLanguage } from '../search/searchByNaturalLanguage.ts';
import { getIconDetails } from '../search/getIconDetails.ts';
import { CANONICAL_CATEGORIES, IconSearchResultSchema, InvalidCategoryError } from '../search/types.ts';

// Shared by every search tool's input -- how many results to return at
// most. `.default(10)` means a caller can omit `limit` entirely and still
// get sensible results.
const limitSchema = z.number().int().min(1).max(50).default(10);

/**
 * Wraps a search-tool handler so that a known, expected failure
 * (currently just `InvalidCategoryError`) comes back to the calling AI
 * assistant as a normal tool result it can react to (e.g. "that category
 * doesn't exist, here are the valid ones") instead of crashing the whole
 * request. Unexpected errors still propagate -- only errors we recognize
 * and can explain get this friendlier treatment.
 */
async function runSearch<T>(searchFn: () => Promise<T>) {
  try {
    const results = await searchFn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }], structuredContent: { results } };
  } catch (error) {
    if (error instanceof InvalidCategoryError) {
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
    throw error;
  }
}

/**
 * Builds a fresh MCP server instance wired up to the given Neo4j driver.
 *
 * This function itself does no I/O -- it just registers tool definitions
 * (closures over `driver`) -- which matters because the server is hosted
 * via a STATELESS model (see index.ts): a brand-new `McpServer` is built
 * for every single incoming HTTP request. `driver` is created ONCE,
 * outside this function, and passed in, so every one of those per-request
 * servers shares the same underlying connection pool rather than each
 * opening its own.
 */
export function buildMcpServer(driver: Driver): McpServer {
  const server = new McpServer({ name: 'canvas-icon-search', version: '0.1.0' });

  server.registerTool(
    'search_icons_by_name',
    {
      description: 'Find a Canvas Kit icon by its exact or partial internal name (e.g. "arrow-up", "accessibility").',
      inputSchema: z.object({ query: z.string().min(1), limit: limitSchema }),
      outputSchema: z.object({ results: z.array(IconSearchResultSchema) }),
    },
    async ({ query, limit }) => runSearch(() => searchIconsByName(driver, query, limit)),
  );

  server.registerTool(
    'search_icons_by_category',
    {
      description: 'List every Canvas Kit icon in a given category.',
      inputSchema: z.object({ category: z.enum(CANONICAL_CATEGORIES), limit: limitSchema }),
      outputSchema: z.object({ results: z.array(IconSearchResultSchema) }),
    },
    async ({ category, limit }) => runSearch(() => searchIconsByCategory(driver, category, limit)),
  );

  server.registerTool(
    'search_icons_by_tag',
    {
      description: 'Find Canvas Kit icons connected to a given tag or synonym (e.g. "airplane", "delete").',
      inputSchema: z.object({ tag: z.string().min(1), limit: limitSchema }),
      outputSchema: z.object({ results: z.array(IconSearchResultSchema) }),
    },
    async ({ tag, limit }) => runSearch(() => searchIconsByTag(driver, tag, limit)),
  );

  server.registerTool(
    'search_icons_by_natural_language',
    {
      description:
        'Find a Canvas Kit icon by describing what it looks like or what you would use it for, in plain ' +
        'language, when you do not know its exact name, category, or tag (e.g. "arrow pointing down", ' +
        '"something for canceling an action"). Combines keyword and semantic-similarity matching.',
      inputSchema: z.object({ query: z.string().min(1), limit: limitSchema }),
      outputSchema: z.object({ results: z.array(IconSearchResultSchema) }),
    },
    async ({ query, limit }) => runSearch(() => searchIconsByNaturalLanguage(driver, query, limit)),
  );

  server.registerTool(
    'get_icon_details',
    {
      description: 'Get full details (all tags, synonyms, and use cases) for one Canvas Kit icon by its exact name.',
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) => {
      const icon = await getIconDetails(driver, name);
      if (!icon) {
        return { content: [{ type: 'text' as const, text: `No icon found with name "${name}".` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(icon, null, 2) }], structuredContent: { icon } };
    },
  );

  return server;
}
