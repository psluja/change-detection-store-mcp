import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

const READY_ATTEMPTS = 60;
const READY_INTERVAL_MS = 1000;

/**
 * Provides a DynamoDB Local endpoint to the integration suite:
 * - `CDS_DYNAMODB_ENDPOINT` env var, when set (external instance), else
 * - a fresh `amazon/dynamodb-local` docker container on a random port.
 */
export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.CDS_DYNAMODB_ENDPOINT;
  if (external !== undefined && external !== '') {
    project.provide('dynamodbEndpoint', external);
    return async () => {
      // external instance — nothing to tear down
    };
  }

  let containerId: string;
  try {
    const { stdout } = await run('docker', [
      'run',
      '-d',
      '--rm',
      '-p',
      '127.0.0.1:0:8000',
      'amazon/dynamodb-local',
    ]);
    containerId = stdout.trim();
  } catch (error) {
    throw new Error(
      'Integration tests need DynamoDB Local: either set CDS_DYNAMODB_ENDPOINT ' +
        'to a running instance or make docker available (image amazon/dynamodb-local).',
      { cause: error },
    );
  }

  const { stdout: portOutput } = await run('docker', ['port', containerId, '8000']);
  const firstMapping = portOutput.trim().split('\n')[0] ?? '';
  const port = firstMapping.slice(firstMapping.lastIndexOf(':') + 1);
  const endpoint = `http://127.0.0.1:${port}`;

  await waitForReady(endpoint);
  project.provide('dynamodbEndpoint', endpoint);

  return async () => {
    await run('docker', ['stop', containerId]);
  };
}

async function waitForReady(endpoint: string): Promise<void> {
  const client = new DynamoDBClient({
    endpoint,
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
      try {
        await client.send(new ListTablesCommand({}));
        return;
      } catch {
        await sleep(READY_INTERVAL_MS);
      }
    }
    throw new Error(`DynamoDB Local at ${endpoint} did not become ready in time`);
  } finally {
    client.destroy();
  }
}
