import type { OAuthConfig } from './config.js';
import type { HttpResponse } from './http.js';
import { oauthErrorResponse, redirectResponse } from './http.js';
import { encodeRelayState } from './relay-state.js';

/**
 * GET /auth/authorize — validates the client request and redirects to the
 * Cognito hosted UI, swapping the redirect URI for our /auth/callback and
 * tunnelling the client's state + redirect URI through the relay state.
 */
export function handleAuthorize(
  config: OAuthConfig,
  baseUrl: string,
  query: URLSearchParams,
): HttpResponse {
  const clientId = query.get('client_id');
  if (clientId !== config.clientId) {
    return oauthErrorResponse(400, 'invalid_request', 'Unknown client_id');
  }

  const redirectUri = query.get('redirect_uri');
  if (redirectUri === null || !config.allowedRedirectUris.includes(redirectUri)) {
    return oauthErrorResponse(400, 'invalid_request', 'redirect_uri is not on the allowlist');
  }

  if (query.get('response_type') !== 'code') {
    return oauthErrorResponse(400, 'unsupported_response_type', 'Only response_type=code');
  }

  const codeChallenge = query.get('code_challenge');
  if (codeChallenge === null || query.get('code_challenge_method') !== 'S256') {
    return oauthErrorResponse(400, 'invalid_request', 'PKCE with S256 is required');
  }

  const clientState = query.get('state');
  const upstream = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: `${baseUrl}/auth/callback`,
    state: encodeRelayState({
      redirectUri,
      ...(clientState === null ? {} : { clientState }),
    }),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: query.get('scope') ?? 'openid email profile',
  });
  return redirectResponse(`${config.cognitoDomain}/oauth2/authorize?${upstream.toString()}`);
}
