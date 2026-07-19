import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { inject } from 'vitest';

import {
  createDynamoDbDocumentClient,
  DynamoDbStorage,
} from '../../src/infrastructure/dynamodb/dynamo-db-storage.js';
import { describeStorageContract } from '../contract/storage-contract.js';

const endpoint = inject('dynamodbEndpoint');

describeStorageContract({
  name: 'DynamoDbStorage (DynamoDB Local)',
  createStorage: async () => {
    const client = new DynamoDBClient({
      endpoint,
      region: 'eu-central-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const tableName = `cds-contract-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });

    const documentClient = createDynamoDbDocumentClient(client);
    const storage = new DynamoDbStorage(documentClient, tableName);
    return {
      stores: storage,
      items: storage,
      teardown: async () => {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
        client.destroy();
      },
    };
  },
});
