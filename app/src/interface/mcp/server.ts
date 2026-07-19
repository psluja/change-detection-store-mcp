import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { APP_INFO } from '../../app-info.js';
import type { AppHandlers } from '../../composition/root.js';
import { DomainError } from '../../domain/errors.js';
import { ITEM_KEY_PATTERN } from '../../domain/item-key.js';
import type { JsonValue } from '../../domain/json.js';
import { STORE_NAME_PATTERN } from '../../domain/store-name.js';
import type { Telemetry } from '../telemetry.js';
import { NOOP_TELEMETRY } from '../telemetry.js';

const storeNameSchema = z
  .string()
  .regex(STORE_NAME_PATTERN, 'store name must match ^[a-z0-9_-]{3,12}$')
  .describe('Store name: 3-12 chars from a-z, 0-9, "-", "_"');

const itemKeySchema = z
  .string()
  .regex(ITEM_KEY_PATTERN, 'item key must match ^[a-zA-Z0-9_|-]{3,32}$')
  .describe(
    'Item key: 3-32 chars from a-z, A-Z, 0-9, "-", "_", "|" — case-sensitive (e.g. "source|ID6HfGma")',
  );

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const cursorSchema = z
  .string()
  .describe('Opaque pagination cursor returned as nextCursor by a previous call');

const metaSchema = jsonValueSchema.describe(
  'Optional sidecar JSON stored on EVERY call but NEVER hashed — for often-changing info outside change detection (e.g. lastSeenAt). Replaces the previous meta whole. Max 64 KB.',
);

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

/** Domain errors map 1:1 to tool errors; anything else is masked and logged. */
async function runTool(
  telemetry: Telemetry,
  tool: string,
  operation: () => Promise<unknown>,
): Promise<CallToolResult> {
  telemetry.toolCalled(tool);
  try {
    return jsonResult(await operation());
  } catch (error) {
    if (error instanceof DomainError) {
      telemetry.toolErrored(tool, error.code);
      return errorResult(error.code, error.message);
    }
    telemetry.internalError(tool);
    // Structured log without item values; never leak internals to the client.
    console.error(
      JSON.stringify({
        event: 'tool_failure',
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
      }),
    );
    return errorResult('INTERNAL_ERROR', 'Unexpected failure; see server logs');
  }
}

/** One stateless server instance per request — the Lambda-friendly MCP shape. */
export function buildMcpServer(
  handlers: AppHandlers,
  telemetry: Telemetry = NOOP_TELEMETRY,
): McpServer {
  const server = new McpServer({ name: APP_INFO.name, version: APP_INFO.version });

  server.registerTool(
    'create_store',
    {
      title: 'Ensure store exists',
      description:
        'Idempotent: creates a named store for change-detected JSON items, or returns the existing one — safe to call at the start of every run. The `created` field tells whether this call created it. A name soft-deleted earlier is reactivated as an empty store.',
      inputSchema: { name: storeNameSchema },
    },
    ({ name }) => runTool(telemetry, 'create_store', () => handlers.createStore.execute({ name })),
  );

  server.registerTool(
    'list_stores',
    {
      title: 'List stores',
      description: 'Lists all live stores with their creation dates, sorted by name.',
      inputSchema: {},
    },
    () => runTool(telemetry, 'list_stores', () => handlers.listStores.execute()),
  );

  server.registerTool(
    'delete_store',
    {
      title: 'Delete store',
      description:
        'Soft-deletes a store together with all its items and history. Data becomes invisible immediately and is physically removed within about 7 days.',
      inputSchema: { name: storeNameSchema },
    },
    ({ name }) => runTool(telemetry, 'delete_store', () => handlers.deleteStore.execute({ name })),
  );

  server.registerTool(
    'patch_item',
    {
      title: 'Write item value if changed',
      description:
        'Stores a JSON value under a key ONLY when its content hash differs from the last stored one (SHA-256 over RFC 8785 canonical JSON). Returns changed=true when a new version was recorded, changed=false when the value is identical. Object key order and number formatting do not affect the hash; ARRAY ORDER DOES — keep arrays stably ordered on the client. The optional `meta` sidecar is persisted on EVERY call (even when changed=false) and never affects the hash.',
      inputSchema: {
        store: storeNameSchema,
        key: itemKeySchema,
        value: jsonValueSchema.describe('Arbitrary JSON value, max 64 KB after canonicalization'),
        meta: metaSchema.optional(),
      },
    },
    ({ store, key, value, meta }) =>
      runTool(telemetry, 'patch_item', async () => {
        const result = await handlers.patchItem.execute({ store, key, value, meta });
        telemetry.changeOutcomes(result.changed ? 1 : 0, result.changed ? 0 : 1);
        return result;
      }),
  );

  server.registerTool(
    'patch_items',
    {
      title: 'Write many item values if changed',
      description:
        'Batch variant of patch_item: applies up to 50 (key, value, meta?) writes in one call, each recorded ONLY when its content hash changed (meta is persisted always). Returns per-key results in input order — { key, changed, hash, date } on success or { key, error } for that item alone (a missing store fails the whole call). Same hashing rules as patch_item.',
      inputSchema: {
        store: storeNameSchema,
        items: z
          .array(
            z.object({ key: itemKeySchema, value: jsonValueSchema, meta: metaSchema.optional() }),
          )
          .min(1)
          .max(50)
          .describe('Items to write, 1-50 per call'),
      },
    },
    ({ store, items }) =>
      runTool(telemetry, 'patch_items', async () => {
        const result = await handlers.patchItems.execute({ store, items });
        let changed = 0;
        let unchanged = 0;
        for (const entry of result.results) {
          if ('error' in entry) {
            telemetry.toolErrored('patch_items', entry.error.split(':')[0] ?? 'UNKNOWN');
          } else if (entry.changed) {
            changed += 1;
          } else {
            unchanged += 1;
          }
        }
        telemetry.changeOutcomes(changed, unchanged);
        return result;
      }),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get item',
      description:
        'Returns the latest value of a key with its content hash, last-change date and the sidecar meta (when present), or { found: false } when the key has no value yet — a missing key is a normal state, not an error.',
      inputSchema: { store: storeNameSchema, key: itemKeySchema },
    },
    ({ store, key }) =>
      runTool(telemetry, 'get_item', () => handlers.getItem.execute({ store, key })),
  );

  server.registerTool(
    'list_items',
    {
      title: 'List items',
      description:
        'Lists item metadata (key, last-change date, hash) of a store, sorted by key, 100 per page. Pass nextCursor from the previous page to continue.',
      inputSchema: { store: storeNameSchema, cursor: cursorSchema.optional() },
    },
    ({ store, cursor }) =>
      runTool(telemetry, 'list_items', () => handlers.listItems.execute({ store, cursor })),
  );

  server.registerTool(
    'get_item_history',
    {
      title: 'Get item history',
      description:
        'Returns the change history of a key from the last 30 days, newest first: date, hash, full value and the meta snapshot of every recorded change. Default page 50, max 200.',
      inputSchema: {
        store: storeNameSchema,
        key: itemKeySchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Page size, 1-200 (default 50)'),
        cursor: cursorSchema.optional(),
      },
    },
    ({ store, key, limit, cursor }) =>
      runTool(telemetry, 'get_item_history', () =>
        handlers.getItemHistory.execute({ store, key, limit, cursor }),
      ),
  );

  server.registerTool(
    'delete_item',
    {
      title: 'Delete item',
      description:
        'Soft-deletes a key: its latest value and whole history become invisible immediately and are physically removed within about 7 days. Patching the key afterwards starts a fresh life.',
      inputSchema: { store: storeNameSchema, key: itemKeySchema },
    },
    ({ store, key }) =>
      runTool(telemetry, 'delete_item', () => handlers.deleteItem.execute({ store, key })),
  );

  return server;
}
