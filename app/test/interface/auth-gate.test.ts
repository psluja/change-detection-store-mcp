import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';

import { CognitoAccessTokenVerifier } from '../../src/infrastructure/cognito/cognito-access-token-verifier.js';
import type { OAuthConfig } from '../../src/interface/oauth/config.js';
import { TokenProxy } from '../../src/interface/oauth/token-proxy.js';
import { NOOP_TELEMETRY } from '../../src/interface/telemetry.js';
import { createLambdaHandler } from '../../src/lambda.js';
import type { LambdaHandler } from '../../src/lambda.js';
import { buildTestEnv } from '../helpers/test-env.js';

const USER_POOL_ID = 'eu-central-1_TESTPOOL';
const CLIENT_ID = 'client-123';
const ISSUER = `https://cognito-idp.eu-central-1.amazonaws.com/${USER_POOL_ID}`;
const KID = 'test-key-1';

const config: OAuthConfig = {
  userPoolId: USER_POOL_ID,
  clientId: CLIENT_ID,
  cognitoDomain: 'https://cds-auth-test.auth.eu-central-1.amazoncognito.com',
  requiredGroup: 'cds-allowed',
  allowedRedirectUris: ['https://claude.ai/api/mcp/auth_callback'],
};

interface TokenOptions {
  groups?: string[];
  clientId?: string;
  expiresIn?: string;
}

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwks: { keys: Record<string, unknown>[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
});

async function signAccessToken(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({
    token_use: 'access',
    client_id: options.clientId ?? CLIENT_ID,
    ...(options.groups === undefined ? {} : { 'cognito:groups': options.groups }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setSubject('user-123')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .setJti('jti-1')
    .sign(privateKey);
}

function buildVerifier(): CognitoAccessTokenVerifier {
  const verifier = new CognitoAccessTokenVerifier({
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    requiredGroup: 'cds-allowed',
  });
  verifier.cacheJwks(jwks as unknown as Parameters<CognitoAccessTokenVerifier['cacheJwks']>[0]);
  return verifier;
}

describe('CognitoAccessTokenVerifier', () => {
  it('accepts a valid access token of a group member', async () => {
    const verdict = await buildVerifier().verify(
      await signAccessToken({ groups: ['cds-allowed'] }),
    );
    expect(verdict).toEqual({ status: 'ok', subject: 'user-123' });
  });

  it('returns forbidden for a valid token without the required group', async () => {
    const missing = await buildVerifier().verify(await signAccessToken());
    expect(missing).toEqual({ status: 'forbidden' });

    const wrongGroup = await buildVerifier().verify(
      await signAccessToken({ groups: ['other-group'] }),
    );
    expect(wrongGroup).toEqual({ status: 'forbidden' });
  });

  it('returns unauthorized for expired, foreign-client and malformed tokens', async () => {
    const verifier = buildVerifier();
    expect(
      await verifier.verify(await signAccessToken({ groups: ['cds-allowed'], expiresIn: '-1h' })),
    ).toEqual({ status: 'unauthorized' });
    expect(
      await verifier.verify(
        await signAccessToken({ groups: ['cds-allowed'], clientId: 'other-client' }),
      ),
    ).toEqual({ status: 'unauthorized' });
    expect(await verifier.verify('not-a-jwt')).toEqual({ status: 'unauthorized' });
  });
});

describe('lambda handler with the OAuth gate on', () => {
  function buildGatedHandler(): LambdaHandler {
    return createLambdaHandler(() => ({
      handlers: buildTestEnv(),
      telemetry: NOOP_TELEMETRY,
      auth: {
        kind: 'cognito',
        config,
        verifier: buildVerifier(),
        tokenProxy: new TokenProxy(
          config,
          { getClientSecret: () => Promise.resolve('unused') },
          () => Promise.reject(new Error('no upstream in this test')),
        ),
      },
    }));
  }

  function mcpEvent(authorization?: string): APIGatewayProxyEventV2 {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/mcp',
      rawQueryString: '',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization === undefined ? {} : { authorization }),
      },
      requestContext: {
        http: { method: 'POST', path: '/mcp', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4' },
        domainName: 'xyz.lambda-url.eu-central-1.on.aws',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_stores', arguments: {} },
      }),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
  }

  it('rejects a missing token with 401 and a resource_metadata challenge', async () => {
    const response = await buildGatedHandler()(mcpEvent());
    expect(response.statusCode).toBe(401);
    expect(response.headers?.['www-authenticate']).toContain(
      'resource_metadata="https://xyz.lambda-url.eu-central-1.on.aws/.well-known/oauth-protected-resource"',
    );
  });

  it('rejects a valid token without the group with 403', async () => {
    const token = await signAccessToken({ groups: ['other-group'] });
    const response = await buildGatedHandler()(mcpEvent(`Bearer ${token}`));
    expect(response.statusCode).toBe(403);
  });

  it('lets a group member through to the MCP server', async () => {
    const token = await signAccessToken({ groups: ['cds-allowed'] });
    const response = await buildGatedHandler()(mcpEvent(`Bearer ${token}`));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('\\"stores\\":[]');
  });

  it('serves discovery metadata derived from the invocation host', async () => {
    const handler = buildGatedHandler();
    const event = {
      ...mcpEvent(),
      rawPath: '/.well-known/oauth-protected-resource',
      requestContext: {
        http: { method: 'GET', path: '/.well-known/oauth-protected-resource' },
        domainName: 'xyz.lambda-url.eu-central-1.on.aws',
      },
      body: undefined,
    } as unknown as APIGatewayProxyEventV2;

    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({
      resource: 'https://xyz.lambda-url.eu-central-1.on.aws/mcp',
    });
  });
});
