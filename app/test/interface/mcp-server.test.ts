import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { buildMcpServer } from '../../src/interface/mcp/server.js';
import { buildTestEnv } from '../helpers/test-env.js';

async function connectedClient(): Promise<Client> {
  const env = buildTestEnv();
  const server = buildMcpServer(env);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Interop casts only: the SDK types are not exactOptionalPropertyTypes-clean.
  await Promise.all([
    client.connect(clientTransport as unknown as Transport),
    server.connect(serverTransport as unknown as Transport),
  ]);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== 'text') {
    throw new Error('Expected a text content block');
  }
  return block.text;
}

function payloadOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

describe('MCP server', () => {
  it('exposes exactly the nine specified tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_store',
      'delete_item',
      'delete_store',
      'get_item',
      'get_item_history',
      'list_items',
      'list_stores',
      'patch_item',
      'patch_items',
    ]);
  });

  it('runs the full change-detection lifecycle over the protocol', async () => {
    const client = await connectedClient();

    await callTool(client, 'create_store', { name: 'prices' });

    const first = await callTool(client, 'patch_item', {
      store: 'prices',
      key: 'source|43533322',
      value: { price: 100, tags: ['new'] },
    });
    expect(payloadOf(first)).toMatchObject({ changed: true });

    // Same value, different key order — must not be a change.
    const second = await callTool(client, 'patch_item', {
      store: 'prices',
      key: 'source|43533322',
      value: { tags: ['new'], price: 100 },
    });
    expect(payloadOf(second)).toMatchObject({ changed: false });

    const third = await callTool(client, 'patch_item', {
      store: 'prices',
      key: 'source|43533322',
      value: { price: 120, tags: ['new'] },
    });
    expect(payloadOf(third)).toMatchObject({ changed: true });

    const item = await callTool(client, 'get_item', {
      store: 'prices',
      key: 'source|43533322',
    });
    expect(payloadOf(item)).toMatchObject({ value: { price: 120, tags: ['new'] } });

    const listed = await callTool(client, 'list_items', { store: 'prices' });
    expect(payloadOf(listed)).toMatchObject({ items: [{ key: 'source|43533322' }] });

    const history = await callTool(client, 'get_item_history', {
      store: 'prices',
      key: 'source|43533322',
    });
    const historyPayload = payloadOf(history) as { entries: { value: unknown }[] };
    expect(historyPayload.entries.map((entry) => entry.value)).toEqual([
      { price: 120, tags: ['new'] },
      { price: 100, tags: ['new'] },
    ]);

    await callTool(client, 'delete_item', { store: 'prices', key: 'source|43533322' });
    const afterDelete = await callTool(client, 'get_item', {
      store: 'prices',
      key: 'source|43533322',
    });
    expect(payloadOf(afterDelete)).toEqual({ found: false });
  });

  it('runs a batch through patch_items with per-key change detection', async () => {
    const client = await connectedClient();
    await callTool(client, 'create_store', { name: 'prices' });

    const first = await callTool(client, 'patch_items', {
      store: 'prices',
      items: [
        { key: 'ext|ID6HfGma', value: { price: 1 } },
        { key: 'offer|2', value: { price: 2 } },
      ],
    });
    expect((payloadOf(first) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ key: 'ext|ID6HfGma', changed: true }),
      expect.objectContaining({ key: 'offer|2', changed: true }),
    ]);

    const rerun = await callTool(client, 'patch_items', {
      store: 'prices',
      items: [{ key: 'ext|ID6HfGma', value: { price: 1 } }],
    });
    expect((payloadOf(rerun) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ key: 'ext|ID6HfGma', changed: false }),
    ]);
  });

  it('maps domain errors to tool errors with stable codes', async () => {
    const client = await connectedClient();
    await callTool(client, 'create_store', { name: 'prices' });

    const duplicate = await callTool(client, 'create_store', { name: 'prices' });
    expect(duplicate.isError).toBeUndefined();
    expect(payloadOf(duplicate)).toMatchObject({ created: false });

    const missingStore = await callTool(client, 'get_item', { store: 'nostore', key: 'offer|1' });
    expect(missingStore.isError).toBe(true);
    expect(textOf(missingStore)).toMatch(/^STORE_NOT_FOUND: /);

    const missingItem = await callTool(client, 'delete_item', { store: 'prices', key: 'offer|9' });
    expect(missingItem.isError).toBe(true);
    expect(textOf(missingItem)).toMatch(/^ITEM_NOT_FOUND: /);
  });

  it('rejects schema-invalid input at the protocol layer', async () => {
    const client = await connectedClient();

    const badName = await callTool(client, 'create_store', { name: 'BAD NAME' });
    expect(badName.isError).toBe(true);
    expect(textOf(badName)).toContain('Input validation error');

    const badKey = await callTool(client, 'patch_item', { store: 'prices', key: 'a#b', value: 1 });
    expect(badKey.isError).toBe(true);
    expect(textOf(badKey)).toContain('Input validation error');
  });
});
