import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import type { AppRuntime } from './composition/root.js';
import { buildProductionRuntime } from './composition/root.js';
import { buildMcpServer } from './interface/mcp/server.js';
import { authorizeMcpRequest } from './interface/oauth/auth-gate.js';
import { handleAuthorize } from './interface/oauth/authorize.js';
import { handleCallback } from './interface/oauth/callback.js';
import { jsonResponse } from './interface/oauth/http.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from './interface/oauth/metadata.js';

const MCP_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

export type LambdaHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

/**
 * Function URL router. The runtime (handlers + auth) is built lazily once per
 * container (the promise is memoized, so concurrent cold-start invocations
 * share one initialization); the MCP server itself is stateless — one
 * instance per request.
 */
export function createLambdaHandler(
  buildRuntime: () => AppRuntime | Promise<AppRuntime>,
): LambdaHandler {
  let runtimePromise: Promise<AppRuntime> | undefined;
  return async (event) => {
    // Never cache a FAILED initialization: transient cold-start errors (e.g.
    // IAM propagation right after deploy) must be retried on the next
    // invocation, not frozen into the container for its lifetime.
    runtimePromise ??= Promise.resolve(buildRuntime()).catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
    const runtime = await runtimePromise;
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;
    const baseUrl = baseUrlOf(event);
    const query = new URLSearchParams(event.rawQueryString);
    const auth = runtime.auth;

    // OAuth endpoints exist only when the OAuth gate is on.
    if (auth.kind === 'cognito') {
      // RFC 9728 allows the resource path as a suffix of the well-known path.
      if (path === PROTECTED_RESOURCE_PATH || path === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`) {
        return methodGate(method, 'GET', () =>
          Promise.resolve(jsonResponse(200, protectedResourceMetadata(baseUrl))),
        );
      }
      if (
        path === AUTH_SERVER_METADATA_PATH ||
        path === `${AUTH_SERVER_METADATA_PATH}${MCP_PATH}`
      ) {
        return methodGate(method, 'GET', () =>
          Promise.resolve(jsonResponse(200, authorizationServerMetadata(baseUrl))),
        );
      }
      if (path === '/auth/authorize') {
        return methodGate(method, 'GET', () =>
          Promise.resolve(handleAuthorize(auth.config, baseUrl, query)),
        );
      }
      if (path === '/auth/callback') {
        return methodGate(method, 'GET', () => Promise.resolve(handleCallback(auth.config, query)));
      }
      if (path === '/auth/token') {
        return methodGate(method, 'POST', () => auth.tokenProxy.handle(baseUrl, rawBodyOf(event)));
      }
    }

    if (path === MCP_PATH) {
      if (method !== 'POST') {
        return jsonResponse(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      }
      if (auth.kind === 'cognito') {
        const verdict = await authorizeMcpRequest(
          auth.verifier,
          baseUrl,
          headerOf(event, 'authorization'),
        );
        if (verdict !== 'allowed') {
          runtime.telemetry.authRejected(verdict.statusCode === 403 ? 'forbidden' : 'unauthorized');
          return verdict;
        }
      }
      return handleMcpRequest(runtime, event);
    }
    return jsonResponse(404, { error: 'not_found' });
  };
}

async function handleMcpRequest(
  runtime: AppRuntime,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawBody = rawBodyOf(event);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
  }

  const server = buildMcpServer(runtime.handlers, runtime.telemetry);
  // Stateless mode (no sessionIdGenerator) + plain JSON responses — Lambda-friendly.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    const request = new Request(`https://lambda.internal${MCP_PATH}`, {
      method: 'POST',
      headers: flattenHeaders(event.headers),
      body: rawBody,
    });
    const response = await transport.handleRequest(request, { parsedBody });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return { statusCode: response.status, headers, body: await response.text() };
  } finally {
    await transport.close();
    await server.close();
  }
}

async function methodGate(
  actual: string,
  expected: 'GET' | 'POST',
  run: () => Promise<APIGatewayProxyStructuredResultV2>,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (actual !== expected) {
    return jsonResponse(405, { error: 'method_not_allowed' }, { allow: expected });
  }
  return run();
}

/** Public origin of this deployment, derived from the actual invocation. */
function baseUrlOf(event: APIGatewayProxyEventV2): string {
  const protocol = headerOf(event, 'x-forwarded-proto') ?? 'https';
  const host = event.requestContext.domainName || (headerOf(event, 'host') ?? '');
  return `${protocol}://${host}`;
}

function headerOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

function rawBodyOf(event: APIGatewayProxyEventV2): string {
  return event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
}

function flattenHeaders(headers: APIGatewayProxyEventV2['headers']): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[name] = value;
    }
  }
  return flat;
}

/** Lambda entry point. */
export const handler: LambdaHandler = createLambdaHandler(buildProductionRuntime);
