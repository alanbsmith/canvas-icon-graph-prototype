// Authentication for the MCP endpoint (/mcp). The REST API (/api/*) is
// deliberately left unauthenticated -- see index.ts for why.
//
// MCP's spec ultimately wants a real OAuth 2.1 setup (a separate
// authorization server issuing tokens, PKCE, token rotation, etc.). That's
// real infrastructure not justified before this has more than one or two
// trusted AI-assistant clients. This file implements the simplest thing
// that satisfies the SDK's `OAuthTokenVerifier` interface: check the
// bearer token against one fixed value from an environment variable.
// Swapping in real OAuth later only means writing a different verifier
// here -- nothing about how it's wired into the server (see index.ts)
// needs to change.

import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { getRequiredEnvVar } from '../env.ts';

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/**
 * Builds a verifier that accepts exactly one fixed API key (from the
 * MCP_API_KEY environment variable) as a bearer token.
 *
 * IMPORTANT, easy to miss: `AuthInfo.expiresAt` is typed as OPTIONAL in
 * the SDK, but the SDK's own request-handling code throws "Token has no
 * expiration time" if it's left unset -- confirmed by reading the actual
 * compiled package, not just its type definitions. A static key doesn't
 * really "expire," so this just sets a expiration far in the future
 * (one year) rather than actually rotating anything.
 */
export function createStaticApiKeyVerifier(): OAuthTokenVerifier {
  const expectedApiKey = getRequiredEnvVar('MCP_API_KEY');

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token !== expectedApiKey) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid API key');
      }
      return {
        token,
        clientId: 'static-api-key',
        scopes: ['search'],
        expiresAt: Math.floor(Date.now() / 1000) + ONE_YEAR_IN_SECONDS,
      };
    },
  };
}
