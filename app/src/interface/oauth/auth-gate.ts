import type { HttpResponse } from './http.js';
import { jsonResponse } from './http.js';
import type { AccessTokenVerifier } from './ports.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Guards POST /mcp. The WWW-Authenticate challenge carries the RFC 9728
 * resource-metadata URL — that is how the MCP connector discovers where to
 * start the OAuth flow after a 401.
 */
export async function authorizeMcpRequest(
  verifier: AccessTokenVerifier,
  baseUrl: string,
  authorizationHeader: string | undefined,
): Promise<'allowed' | HttpResponse> {
  const challenge = {
    'www-authenticate': `Bearer realm="mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
  };
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
    return jsonResponse(401, { error: 'unauthorized' }, challenge);
  }
  const verdict = await verifier.verify(authorizationHeader.slice(BEARER_PREFIX.length));
  if (verdict.status === 'unauthorized') {
    return jsonResponse(401, { error: 'unauthorized' }, challenge);
  }
  if (verdict.status === 'forbidden') {
    return jsonResponse(403, { error: 'forbidden' });
  }
  return 'allowed';
}
