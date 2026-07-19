import type { OAuthConfig } from './config.js';
import type { HttpResponse } from './http.js';
import { oauthErrorResponse } from './http.js';
import type { ClientSecretProvider } from './ports.js';

/** Structural subset of global fetch — injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

const FORWARDED_FIELDS = ['code', 'code_verifier', 'refresh_token', 'scope'] as const;

/**
 * POST /auth/token — proxies the token exchange to Cognito, injecting the app
 * client secret (Basic auth) that never reaches the client, and pinning
 * redirect_uri to our /auth/callback (the one Cognito saw during authorize).
 */
export class TokenProxy {
  constructor(
    private readonly config: OAuthConfig,
    private readonly secrets: ClientSecretProvider,
    private readonly fetchFn: FetchLike,
  ) {}

  async handle(baseUrl: string, rawBody: string): Promise<HttpResponse> {
    const form = new URLSearchParams(rawBody);

    const grantType = form.get('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return oauthErrorResponse(
        400,
        'unsupported_grant_type',
        'Only authorization_code and refresh_token',
      );
    }
    const clientId = form.get('client_id');
    if (clientId !== null && clientId !== this.config.clientId) {
      return oauthErrorResponse(400, 'invalid_client', 'Unknown client_id');
    }

    const upstream = new URLSearchParams({
      grant_type: grantType,
      client_id: this.config.clientId,
    });
    for (const field of FORWARDED_FIELDS) {
      const value = form.get(field);
      if (value !== null) {
        upstream.set(field, value);
      }
    }
    if (grantType === 'authorization_code') {
      upstream.set('redirect_uri', `${baseUrl}/auth/callback`);
    }

    const secret = await this.secrets.getClientSecret();
    const basic = Buffer.from(`${this.config.clientId}:${secret}`, 'utf8').toString('base64');
    const response = await this.fetchFn(`${this.config.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: upstream.toString(),
    });
    return {
      statusCode: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: await response.text(),
    };
  }
}
