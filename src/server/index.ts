// The entry point for the hosted search server. Running `npm run
// search-server` starts this file, which serves TWO interfaces to the
// exact same underlying search logic (src/search/*.ts):
//   - POST /mcp             -- MCP tools, for AI assistants (Claude Code,
//                              Cursor, etc.), protected by a bearer API key
//   - GET  /api/search/...  -- plain JSON REST routes, for the docs
//                              website's search box (browsers can't speak
//                              MCP's protocol), left unauthenticated
//
// One Express process serves both, rather than two separate processes,
// because both need the exact same Neo4j driver/connection pool -- two
// processes would mean either duplicating that setup or building a way
// for them to share it, for no real benefit at this project's scale.

import cors from 'cors';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { getEnvVar } from '../env.ts';
import { createNeo4jDriver } from '../graph/neo4jClient.ts';
import { ensureSchema } from '../graph/schema.ts';
import { buildMcpServer } from './mcpServer.ts';
import { registerRestRoutes } from './restRoutes.ts';
import { createStaticApiKeyVerifier } from './auth.ts';

const PORT = Number(getEnvVar('SEARCH_SERVER_PORT', '3000'));
const HOST = getEnvVar('SEARCH_SERVER_HOST', '127.0.0.1');
const CORS_ALLOWED_ORIGINS = getEnvVar('CORS_ALLOWED_ORIGINS', `http://localhost:${PORT}`)
  .split(',')
  .map((origin) => origin.trim());
// Only needed once this runs somewhere other than a local machine -- see
// createMcpExpressApp's own docs: binding to '0.0.0.0' (or anything other
// than 127.0.0.1/localhost/::1) needs an explicit allow-list, or its
// built-in DNS-rebinding protection has nothing to check requests against.
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',').map((host) => host.trim());
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim());

async function main(): Promise<void> {
  // ONE driver for this whole process's lifetime, shared by both the MCP
  // and REST interfaces (and, within MCP, by every per-request server
  // instance -- see the stateless-factory note in mcpServer.ts). Creating
  // a driver is a real, somewhat expensive setup step (connection pool,
  // handshake) -- it must NOT be created inside a per-request code path.
  const driver = createNeo4jDriver();
  await ensureSchema(driver); // idempotent -- safe to run every time this server starts

  // `createMcpExpressApp()` returns a normal Express app, pre-configured
  // with JSON body parsing and (for localhost binds) DNS-rebinding
  // protection -- we build our routes on top of it exactly like any other
  // Express app.
  const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS, allowedOrigins: ALLOWED_ORIGINS });

  // CORS is required because the docs site's search box is browser
  // JavaScript running on a DIFFERENT origin than this server -- without
  // explicit CORS headers, the browser blocks the response outright
  // before any of our own logic even runs. Scoped to /api only; /mcp is
  // never called from a browser, so it doesn't need this.
  app.use('/api', cors({ origin: CORS_ALLOWED_ORIGINS }));

  // `createMcpHandler` builds a web-standard fetch handler; `toNodeHandler`
  // adapts that to the (req, res, parsedBody) shape a plain Node/Express
  // route handler expects. The factory (`() => buildMcpServer(driver)`)
  // runs fresh on every single request -- see mcpServer.ts for why that's
  // the right model here (many unrelated concurrent clients, no shared
  // session state needed).
  const mcpHandler = createMcpHandler(() => buildMcpServer(driver));
  const mcpNodeHandler = toNodeHandler(mcpHandler);

  app.all('/mcp', requireBearerAuth({ verifier: createStaticApiKeyVerifier() }), (req, res) => {
    void mcpNodeHandler(req, res, req.body);
  });

  registerRestRoutes(app, driver);

  app.listen(PORT, HOST, () => {
    console.log(`Icon search server listening on http://${HOST}:${PORT}`);
    console.log(`  MCP:  http://${HOST}:${PORT}/mcp`);
    console.log(`  REST: http://${HOST}:${PORT}/api/search/{name,category,tag,natural-language}`);
  });
}

main().catch((error) => {
  console.error('Fatal error starting search server:', error);
  process.exitCode = 1;
});
