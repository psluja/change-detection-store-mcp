import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmfTelemetry } from '../../src/infrastructure/telemetry/emf-telemetry.js';
import { buildMcpServer } from '../../src/interface/mcp/server.js';
import type { Telemetry } from '../../src/interface/telemetry.js';
import { buildTestEnv } from '../helpers/test-env.js';

class RecordingTelemetry implements Telemetry {
  readonly calls: string[] = [];
  readonly errors: { tool: string; code: string }[] = [];
  readonly internals: string[] = [];
  readonly outcomes: { changed: number; unchanged: number }[] = [];
  readonly auth: string[] = [];

  toolCalled(tool: string): void {
    this.calls.push(tool);
  }
  toolErrored(tool: string, code: string): void {
    this.errors.push({ tool, code });
  }
  internalError(tool: string): void {
    this.internals.push(tool);
  }
  changeOutcomes(changed: number, unchanged: number): void {
    this.outcomes.push({ changed, unchanged });
  }
  authRejected(outcome: 'unauthorized' | 'forbidden'): void {
    this.auth.push(outcome);
  }
}

async function connectedClient(telemetry: Telemetry): Promise<Client> {
  const server = buildMcpServer(buildTestEnv(), telemetry);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as unknown as Transport),
    server.connect(serverTransport as unknown as Transport),
  ]);
  return client;
}

describe('MCP telemetry', () => {
  it('records tool calls, change outcomes and typed errors', async () => {
    const telemetry = new RecordingTelemetry();
    const client = await connectedClient(telemetry);

    await client.callTool({ name: 'create_store', arguments: { name: 'prices' } });
    await client.callTool({
      name: 'patch_item',
      arguments: { store: 'prices', key: 'offer|1', value: { price: 1 } },
    });
    await client.callTool({
      name: 'patch_item',
      arguments: { store: 'prices', key: 'offer|1', value: { price: 1 } },
    });
    await client.callTool({
      name: 'patch_items',
      arguments: {
        store: 'prices',
        items: [
          { key: 'offer|2', value: 1 },
          { key: 'offer|3', value: { blob: 'x'.repeat(64 * 1024) } }, // per-item domain error
        ],
      },
    });
    await client.callTool({ name: 'get_item', arguments: { store: 'nostore', key: 'offer|1' } });

    expect(telemetry.calls).toEqual([
      'create_store',
      'patch_item',
      'patch_item',
      'patch_items',
      'get_item',
    ]);
    expect(telemetry.outcomes).toEqual([
      { changed: 1, unchanged: 0 }, // first patch: new version
      { changed: 0, unchanged: 1 }, // identical value
      { changed: 1, unchanged: 0 }, // batch: one ok, one bad key
    ]);
    expect(telemetry.errors).toEqual([
      { tool: 'patch_items', code: 'VALUE_TOO_LARGE' },
      { tool: 'get_item', code: 'STORE_NOT_FOUND' },
    ]);
    expect(telemetry.internals).toEqual([]);
  });
});

describe('EmfTelemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits CloudWatch EMF with a per-tool dimension and a dimensionless rollup', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    new EmfTelemetry().toolCalled('patch_item');

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string) as {
      _aws: {
        CloudWatchMetrics: {
          Namespace: string;
          Dimensions: string[][];
          Metrics: { Name: string; Unit: string }[];
        }[];
      };
      Tool: string;
      ToolCalls: number;
    };
    expect(payload._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: 'ChangeDetectionStore',
      Dimensions: [['Tool'], []],
      Metrics: [{ Name: 'ToolCalls', Unit: 'Count' }],
    });
    expect(payload.Tool).toBe('patch_item');
    expect(payload.ToolCalls).toBe(1);
  });

  it('emits change outcomes without dimensions', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    new EmfTelemetry().changeOutcomes(2, 28);

    const payload = JSON.parse(log.mock.calls[0]?.[0] as string) as {
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
      ChangesDetected: number;
      UnchangedCalls: number;
    };
    expect(payload._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    expect(payload.ChangesDetected).toBe(2);
    expect(payload.UnchangedCalls).toBe(28);
  });
});
