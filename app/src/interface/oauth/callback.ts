import type { OAuthConfig } from './config.js';
import type { HttpResponse } from './http.js';
import { oauthErrorResponse, redirectResponse } from './http.js';
import { decodeRelayState } from './relay-state.js';

/**
 * GET /auth/callback — Cognito redirects here after login; we bounce the code
 * (or the upstream error) back to the client's original redirect URI. The
 * allowlist re-check closes the open-redirect hole an unsigned relay state
 * would otherwise leave.
 */
export function handleCallback(config: OAuthConfig, query: URLSearchParams): HttpResponse {
  const encodedState = query.get('state');
  const relay = encodedState === null ? undefined : decodeRelayState(encodedState);
  if (relay === undefined) {
    return oauthErrorResponse(400, 'invalid_request', 'Missing or malformed state');
  }
  if (!config.allowedRedirectUris.includes(relay.redirectUri)) {
    return oauthErrorResponse(400, 'invalid_request', 'redirect_uri is not on the allowlist');
  }

  const target = new URL(relay.redirectUri);
  const upstreamError = query.get('error');
  if (upstreamError !== null) {
    target.searchParams.set('error', upstreamError);
    const description = query.get('error_description');
    if (description !== null) {
      target.searchParams.set('error_description', description);
    }
  } else {
    const code = query.get('code');
    if (code === null) {
      return oauthErrorResponse(400, 'invalid_request', 'Missing authorization code');
    }
    target.searchParams.set('code', code);
  }
  if (relay.clientState !== undefined) {
    target.searchParams.set('state', relay.clientState);
  }
  return redirectResponse(target.toString());
}
