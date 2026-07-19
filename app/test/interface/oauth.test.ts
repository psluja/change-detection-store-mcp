import { describe, expect, it } from 'vitest';

import { handleAuthorize } from '../../src/interface/oauth/authorize.js';
import { handleCallback } from '../../src/interface/oauth/callback.js';
import type { OAuthConfig } from '../../src/interface/oauth/config.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from '../../src/interface/oauth/metadata.js';
import { decodeRelayState, encodeRelayState } from '../../src/interface/oauth/relay-state.js';
import type { FetchLike } from '../../src/interface/oauth/token-proxy.js';
import { TokenProxy } from '../../src/interface/oauth/token-proxy.js';

const BASE_URL = 'https://xyz.lambda-url.eu-central-1.on.aws';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const config: OAuthConfig = {
  userPoolId: 'eu-central-1_TESTPOOL',
  clientId: 'client-123',
  cognitoDomain: 'https://cds-auth-test.auth.eu-central-1.amazoncognito.com',
  requiredGroup: 'cds-allowed',
  allowedRedirectUris: [CLAUDE_CALLBACK],
};

function authorizeQuery(overrides: Record<string, string | null> = {}): URLSearchParams {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'client-123',
    redirect_uri: CLAUDE_CALLBACK,
    state: 'client-state-1',
    code_challenge: 'challenge-abc',
    code_challenge_method: 'S256',
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      query.delete(key);
    } else {
      query.set(key, value);
    }
  }
  return query;
}

describe('discovery metadata', () => {
  it('points the connector at the MCP resource and our proxy endpoints', () => {
    expect(protectedResourceMetadata(BASE_URL)).toMatchObject({
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
    });
    expect(authorizationServerMetadata(BASE_URL)).toMatchObject({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/auth/authorize`,
      token_endpoint: `${BASE_URL}/auth/token`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('authorize', () => {
  it('redirects to the Cognito hosted UI with a swapped redirect_uri and relay state', () => {
    const response = handleAuthorize(config, BASE_URL, authorizeQuery());
    expect(response.statusCode).toBe(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.origin).toBe('https://cds-auth-test.auth.eu-central-1.amazoncognito.com');
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/auth/callback`);
    expect(location.searchParams.get('code_challenge')).toBe('challenge-abc');

    const relay = decodeRelayState(location.searchParams.get('state') ?? '');
    expect(relay).toEqual({ redirectUri: CLAUDE_CALLBACK, clientState: 'client-state-1' });
  });

  it.each([
    ['unknown client_id', { client_id: 'other' }],
    ['redirect_uri off the allowlist', { redirect_uri: 'https://evil.example/cb' }],
    ['missing redirect_uri', { redirect_uri: null }],
    ['non-code response_type', { response_type: 'token' }],
    ['missing PKCE challenge', { code_challenge: null }],
    ['non-S256 PKCE', { code_challenge_method: 'plain' }],
  ])('rejects %s', (_label, overrides) => {
    const response = handleAuthorize(config, BASE_URL, authorizeQuery(overrides));
    expect(response.statusCode).toBe(400);
  });
});

describe('callback', () => {
  it('bounces the code and original state back to the allowlisted client', () => {
    const state = encodeRelayState({ redirectUri: CLAUDE_CALLBACK, clientState: 'cs-9' });
    const response = handleCallback(config, new URLSearchParams({ code: 'auth-code-1', state }));
    expect(response.statusCode).toBe(302);

    const location = new URL(response.headers.location ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('code')).toBe('auth-code-1');
    expect(location.searchParams.get('state')).toBe('cs-9');
  });

  it('passes upstream errors through to the client', () => {
    const state = encodeRelayState({ redirectUri: CLAUDE_CALLBACK });
    const response = handleCallback(
      config,
      new URLSearchParams({ error: 'access_denied', error_description: 'nope', state }),
    );
    const location = new URL(response.headers.location ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toBe('nope');
  });

  it('rejects malformed state and non-allowlisted relay targets', () => {
    expect(
      handleCallback(config, new URLSearchParams({ code: 'x', state: 'garbage!' })).statusCode,
    ).toBe(400);

    const evil = encodeRelayState({ redirectUri: 'https://evil.example/cb' });
    expect(handleCallback(config, new URLSearchParams({ code: 'x', state: evil })).statusCode).toBe(
      400,
    );
  });

  it('rejects a callback without code and without error', () => {
    const state = encodeRelayState({ redirectUri: CLAUDE_CALLBACK });
    expect(handleCallback(config, new URLSearchParams({ state })).statusCode).toBe(400);
  });
});

describe('token proxy', () => {
  function capturingFetch(status = 200, body = '{"access_token":"at"}') {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn: FetchLike = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve({ status, text: () => Promise.resolve(body) });
    };
    return { calls, fetchFn };
  }

  const secrets = { getClientSecret: () => Promise.resolve('s3cret') };

  it('forwards the exchange with injected Basic auth and pinned redirect_uri', async () => {
    const { calls, fetchFn } = capturingFetch();
    const proxy = new TokenProxy(config, secrets, fetchFn);

    const response = await proxy.handle(
      BASE_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'auth-code-1',
        code_verifier: 'verifier-1',
        client_id: 'client-123',
        redirect_uri: CLAUDE_CALLBACK,
      }).toString(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"access_token":"at"}');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${config.cognitoDomain}/oauth2/token`);
    expect(call?.headers.authorization).toBe(
      `Basic ${Buffer.from('client-123:s3cret').toString('base64')}`,
    );

    const upstream = new URLSearchParams(call?.body);
    expect(upstream.get('redirect_uri')).toBe(`${BASE_URL}/auth/callback`);
    expect(upstream.get('code')).toBe('auth-code-1');
    expect(upstream.get('code_verifier')).toBe('verifier-1');
  });

  it('supports refresh_token grants without a redirect_uri', async () => {
    const { calls, fetchFn } = capturingFetch();
    const proxy = new TokenProxy(config, secrets, fetchFn);

    await proxy.handle(
      BASE_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'rt-1' }).toString(),
    );
    const upstream = new URLSearchParams(calls[0]?.body);
    expect(upstream.get('refresh_token')).toBe('rt-1');
    expect(upstream.get('redirect_uri')).toBeNull();
  });

  it('rejects unsupported grants and foreign client ids without calling upstream', async () => {
    const { calls, fetchFn } = capturingFetch();
    const proxy = new TokenProxy(config, secrets, fetchFn);

    const badGrant = await proxy.handle(BASE_URL, 'grant_type=password');
    expect(badGrant.statusCode).toBe(400);

    const badClient = await proxy.handle(
      BASE_URL,
      'grant_type=authorization_code&code=x&client_id=other',
    );
    expect(badClient.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('passes upstream error responses through unchanged', async () => {
    const { fetchFn } = capturingFetch(400, '{"error":"invalid_grant"}');
    const proxy = new TokenProxy(config, secrets, fetchFn);
    const response = await proxy.handle(BASE_URL, 'grant_type=authorization_code&code=expired');
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"invalid_grant"}');
  });
});
