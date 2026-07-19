import { createServer } from 'node:http';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { buildHandlers, buildProductionHandlers } from '../src/composition/root.js';
import type { AppHandlers } from '../src/composition/root.js';
import { InMemoryStorage } from '../src/infrastructure/in-memory/in-memory-storage.js';
import { JcsContentHasher } from '../src/infrastructure/jcs-content-hasher.js';
import { SystemClock } from '../src/infrastructure/system-clock.js';
import { UlidIdGenerator } from '../src/infrastructure/ulid-id-generator.js';
import { NOOP_TELEMETRY } from '../src/interface/telemetry.js';
import { createLambdaHandler } from '../src/lambda.js';

/**
 * Local MCP server for manual testing (e.g. MCP Inspector):
 *   npm run dev --workspace app
 *   npx @modelcontextprotocol/inspector  →  http://localhost:3000/mcp
 *
 * Storage: in-memory by default; set CDS_TABLE_NAME (+ AWS credentials) to
 * exercise the DynamoDB adapter. Requests flow through the real Lambda
 * handler; the OAuth gate is deliberately disabled locally.
 */

const port = Number(process.env.PORT ?? '3000');
const useDynamoDb = process.env.CDS_TABLE_NAME !== undefined && process.env.CDS_TABLE_NAME !== '';

function buildDevHandlers(): AppHandlers {
  if (useDynamoDb) {
    return buildProductionHandlers();
  }
  const storage = new InMemoryStorage();
  return buildHandlers({
    stores: storage,
    items: storage,
    hasher: new JcsContentHasher(),
    clock: new SystemClock(),
    ids: new UlidIdGenerator(),
  });
}

const lambdaHandler = createLambdaHandler(() => ({
  handlers: buildDevHandlers(),
  auth: { kind: 'disabled' },
  telemetry: NOOP_TELEMETRY,
}));

createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const [rawPath, rawQueryString] = (request.url ?? '/').split('?', 2);
    const event = {
      rawPath,
      rawQueryString: rawQueryString ?? '',
      headers: { ...request.headers, 'x-forwarded-proto': 'http' },
      requestContext: { http: { method: request.method ?? 'GET' } },
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;

    const result = await lambdaHandler(event);
    response.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>);
    response.end(result.body ?? '');
  })().catch((error: unknown) => {
    console.error(error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'internal_error' }));
  });
}).listen(port, () => {
  console.log(
    `MCP dev server: http://localhost:${String(port)}/mcp (storage: ${useDynamoDb ? 'DynamoDB' : 'in-memory'})`,
  );
});
