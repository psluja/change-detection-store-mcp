import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { NOOP_TELEMETRY } from '../../src/interface/telemetry.js';
import type { LambdaHandler } from '../../src/lambda.js';
import { createLambdaHandler } from '../../src/lambda.js';
import { buildTestEnv } from '../helpers/test-env.js';

function buildLocalHandler(): LambdaHandler {
  return createLambdaHandler(() => ({
    handlers: buildTestEnv(),
    auth: { kind: 'disabled' },
    telemetry: NOOP_TELEMETRY,
  }));
}

function functionUrlEvent(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function parseBody(body: string | undefined): JsonRpcResponse {
  if (body === undefined) {
    throw new Error('Expected a response body');
  }
  return JSON.parse(body) as JsonRpcResponse;
}

let nextId = 0;

function rpc(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  nextId += 1;
  return { jsonrpc: '2.0', id: nextId, method, params };
}

describe('lambda handler', () => {
  it('answers an MCP initialize request over a Function URL event', async () => {
    const handler = buildLocalHandler();
    const response = await handler(
      functionUrlEvent('POST', '/mcp', {
        ...rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.1' },
        }),
      }),
    );

    expect(response.statusCode).toBe(200);
    const payload = parseBody(response.body);
    expect(payload.result).toMatchObject({
      serverInfo: { name: 'change-detection-store-mcp' },
    });
  });

  it('executes tool calls end to end, each request stateless', async () => {
    const handler = buildLocalHandler();

    const created = await handler(
      functionUrlEvent(
        'POST',
        '/mcp',
        rpc('tools/call', { name: 'create_store', arguments: { name: 'prices' } }),
      ),
    );
    expect(created.statusCode).toBe(200);

    const patched = await handler(
      functionUrlEvent(
        'POST',
        '/mcp',
        rpc('tools/call', {
          name: 'patch_item',
          arguments: { store: 'prices', key: 'offer|1', value: { price: 1 } },
        }),
      ),
    );
    const patchedPayload = parseBody(patched.body);
    const content = (patchedPayload.result as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ changed: true });
  });

  it('returns 405 for non-POST on /mcp and 404 elsewhere', async () => {
    const handler = buildLocalHandler();
    const get = await handler(functionUrlEvent('GET', '/mcp'));
    expect(get.statusCode).toBe(405);

    const elsewhere = await handler(functionUrlEvent('GET', '/unknown'));
    expect(elsewhere.statusCode).toBe(404);
  });

  it('retries a failed runtime initialization instead of caching the rejection', async () => {
    let attempts = 0;
    const handler = createLambdaHandler(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error('transient init failure'));
      }
      return Promise.resolve({
        handlers: buildTestEnv(),
        auth: { kind: 'disabled' as const },
        telemetry: NOOP_TELEMETRY,
      });
    });

    await expect(handler(functionUrlEvent('GET', '/unknown'))).rejects.toThrow(
      'transient init failure',
    );
    const response = await handler(functionUrlEvent('GET', '/unknown'));
    expect(response.statusCode).toBe(404);
    expect(attempts).toBe(2);
  });

  it('returns a JSON-RPC parse error for malformed bodies', async () => {
    const handler = buildLocalHandler();
    const event = functionUrlEvent('POST', '/mcp');
    event.body = '{not json';
    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).error?.code).toBe(-32700);
  });
});
