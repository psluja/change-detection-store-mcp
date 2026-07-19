import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { ItemRepository, Page } from '../../application/ports/item-repository.js';
import type { StoreRepository } from '../../application/ports/store-repository.js';
import type { ContentHash } from '../../domain/content-hash.js';
import type { ItemKey } from '../../domain/item-key.js';
import type { JsonValue } from '../../domain/json.js';
import type { HistoryEntryRecord, LatestItemRecord, StoreRecord } from '../../domain/records.js';
import { cappedDeletionTtl, isLive, toEpochSeconds } from '../../domain/retention.js';
import type { StoreName } from '../../domain/store-name.js';
import { encodeCursor, paginate, requireCursorField } from '../pagination-cursor.js';

const STORE_PK = 'STORE';
const UPDATE_BATCH_SIZE = 10;

/** `#` cannot occur in store names or item keys, so these composites are unambiguous. */
function latestPk(store: StoreName): string {
  return `S#${store}#LATEST`;
}

function historyPk(store: StoreName, key: ItemKey): string {
  return `S#${store}#HIST#${key}`;
}

/**
 * The domain liveness rule (domain/retention.ts) expressed in DynamoDB
 * expression language — the single deliberate duplication, needed because
 * conditions and filters evaluate server-side. `ttl` and `hash` are DynamoDB
 * reserved words, hence the #-aliases.
 */
const LIVE_FILTER =
  'attribute_not_exists(deletedAt) AND (attribute_not_exists(#ttl) OR #ttl > :now)';
const NOT_LIVE_CONDITION =
  'attribute_not_exists(pk) OR attribute_exists(deletedAt) OR (attribute_exists(#ttl) AND #ttl <= :now)';
const LIVE_CONDITION =
  'attribute_exists(pk) AND attribute_not_exists(deletedAt) AND (attribute_not_exists(#ttl) OR #ttl > :now)';

/** Raw shapes of table items; the table is ours, so casts are trusted. */
interface RawLifecycle {
  deletedAt?: string;
  ttl?: number;
}
interface RawStoreItem extends RawLifecycle {
  sk: string;
  createdAt: string;
}
interface RawLatestItem extends RawLifecycle {
  sk: string;
  hash: string;
  date: string;
  value: JsonValue;
  meta?: JsonValue;
}
interface RawHistoryItem extends RawLifecycle {
  sk: string;
  hash: string;
  date: string;
  value: JsonValue;
  meta?: JsonValue;
  ttl: number;
}

function lifecycleOf(raw: RawLifecycle): Partial<RawLifecycle> {
  return {
    ...(raw.deletedAt !== undefined ? { deletedAt: raw.deletedAt } : {}),
    ...(raw.ttl !== undefined ? { ttl: raw.ttl } : {}),
  };
}

function toStoreRecord(raw: RawStoreItem): StoreRecord {
  return { name: raw.sk as StoreName, createdAt: raw.createdAt, ...lifecycleOf(raw) };
}

function toLatestRecord(store: StoreName, raw: RawLatestItem): LatestItemRecord {
  return {
    store,
    key: raw.sk as ItemKey,
    hash: raw.hash as ContentHash,
    date: raw.date,
    value: raw.value,
    ...(raw.meta !== undefined ? { meta: raw.meta } : {}),
    ...lifecycleOf(raw),
  };
}

function toHistoryRecord(store: StoreName, key: ItemKey, raw: RawHistoryItem): HistoryEntryRecord {
  return {
    store,
    key,
    id: raw.sk,
    hash: raw.hash as ContentHash,
    date: raw.date,
    value: raw.value,
    ...(raw.meta !== undefined ? { meta: raw.meta } : {}),
    ttl: raw.ttl,
    ...(raw.deletedAt !== undefined ? { deletedAt: raw.deletedAt } : {}),
  };
}

function chunk<T>(records: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size) {
    chunks.push(records.slice(index, index + size));
  }
  return chunks;
}

/** Wraps a low-level client with the marshalling options this adapter expects. */
export function createDynamoDbDocumentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * DynamoDB implementation of both persistence ports over the single-table
 * layout from the project plan (section 05): PK + SK only, no GSI/LSI.
 */
export class DynamoDbStorage implements StoreRepository, ItemRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  // --- StoreRepository ---

  async createOrReactivate(record: StoreRecord, now: Date): Promise<'created' | 'already-exists'> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: STORE_PK, sk: record.name, createdAt: record.createdAt },
          ConditionExpression: NOT_LIVE_CONDITION,
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': toEpochSeconds(now) },
        }),
      );
      return 'created';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'already-exists';
      }
      throw error;
    }
  }

  async findLive(name: StoreName, now: Date): Promise<StoreRecord | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: STORE_PK, sk: name },
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) {
      return undefined;
    }
    const record = toStoreRecord(output.Item as unknown as RawStoreItem);
    return isLive(record, now) ? record : undefined;
  }

  async listLive(now: Date): Promise<StoreRecord[]> {
    const raw = await this.collectRaw(
      {
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: LIVE_FILTER,
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': STORE_PK, ':now': toEpochSeconds(now) },
      },
      undefined,
      Number.MAX_SAFE_INTEGER,
    );
    return raw
      .map((item) => toStoreRecord(item as unknown as RawStoreItem))
      .filter((record) => isLive(record, now));
  }

  async softDelete(name: StoreName, now: Date): Promise<'deleted' | 'not-found'> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: STORE_PK, sk: name },
          UpdateExpression: 'SET deletedAt = :deletedAt, #ttl = :ttl',
          ConditionExpression: LIVE_CONDITION,
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':deletedAt': now.toISOString(),
            ':ttl': cappedDeletionTtl(now, undefined),
            ':now': toEpochSeconds(now),
          },
        }),
      );
      return 'deleted';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'not-found';
      }
      throw error;
    }
  }

  // --- ItemRepository ---

  async findLatestAny(store: StoreName, key: ItemKey): Promise<LatestItemRecord | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: latestPk(store), sk: key },
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : toLatestRecord(store, output.Item as unknown as RawLatestItem);
  }

  async commitChange(
    latest: LatestItemRecord,
    history: HistoryEntryRecord,
    expectedHash: ContentHash | null,
    now: Date,
  ): Promise<'committed' | 'conflict' | 'store-missing'> {
    const nowEpoch = toEpochSeconds(now);
    const condition =
      expectedHash === null
        ? {
            ConditionExpression: NOT_LIVE_CONDITION,
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':now': nowEpoch },
          }
        : {
            ConditionExpression: `#hash = :expected AND ${LIVE_CONDITION}`,
            ExpressionAttributeNames: { '#ttl': 'ttl', '#hash': 'hash' },
            ExpressionAttributeValues: { ':expected': expectedHash, ':now': nowEpoch },
          };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Store-liveness guard: closes the patch × delete_store race that
              // would otherwise leave an immortal live record in a dead store.
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: STORE_PK, sk: latest.store },
                ConditionExpression: LIVE_CONDITION,
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':now': nowEpoch },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: latestPk(latest.store),
                  sk: latest.key,
                  hash: latest.hash,
                  date: latest.date,
                  value: latest.value,
                  ...(latest.meta !== undefined ? { meta: latest.meta } : {}),
                },
                ...condition,
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: historyPk(history.store, history.key),
                  sk: history.id,
                  hash: history.hash,
                  date: history.date,
                  value: history.value,
                  ...(history.meta !== undefined ? { meta: history.meta } : {}),
                  ttl: history.ttl,
                },
              },
            },
          ],
        }),
      );
      return 'committed';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        // Reasons align with TransactItems order: [store check, latest put, history put].
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          return 'store-missing';
        }
        if (reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
          return 'conflict';
        }
      }
      throw error;
    }
  }

  async updateLatestMeta(
    store: StoreName,
    key: ItemKey,
    expectedHash: ContentHash,
    meta: JsonValue,
    now: Date,
  ): Promise<'updated' | 'conflict'> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: latestPk(store), sk: key },
          UpdateExpression: 'SET #meta = :meta',
          ConditionExpression: `#hash = :expected AND ${LIVE_CONDITION}`,
          ExpressionAttributeNames: { '#meta': 'meta', '#hash': 'hash', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':meta': meta,
            ':expected': expectedHash,
            ':now': toEpochSeconds(now),
          },
        }),
      );
      return 'updated';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'conflict';
      }
      throw error;
    }
  }

  async listLatestLive(
    store: StoreName,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<LatestItemRecord>> {
    const afterKey = cursor === undefined ? undefined : requireCursorField(cursor, 'k');
    const raw = await this.collectRaw(
      {
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: LIVE_FILTER,
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': latestPk(store), ':now': toEpochSeconds(now) },
      },
      afterKey === undefined ? undefined : { pk: latestPk(store), sk: afterKey },
      limit + 1,
    );
    const records = raw
      .map((item) => toLatestRecord(store, item as unknown as RawLatestItem))
      .filter((record) => isLive(record, now));
    return paginate(records, limit, (record) => encodeCursor({ k: record.key }));
  }

  async listHistoryLive(
    store: StoreName,
    key: ItemKey,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<HistoryEntryRecord>> {
    const beforeId = cursor === undefined ? undefined : requireCursorField(cursor, 'i');
    const raw = await this.collectRaw(
      {
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: LIVE_FILTER,
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': historyPk(store, key), ':now': toEpochSeconds(now) },
        ScanIndexForward: false,
      },
      beforeId === undefined ? undefined : { pk: historyPk(store, key), sk: beforeId },
      limit + 1,
    );
    const entries = raw
      .map((item) => toHistoryRecord(store, key, item as unknown as RawHistoryItem))
      .filter((entry) => isLive(entry, now));
    return paginate(entries, limit, (entry) => encodeCursor({ i: entry.id }));
  }

  async softDeleteItem(
    store: StoreName,
    key: ItemKey,
    now: Date,
  ): Promise<'deleted' | 'not-found'> {
    const current = await this.findLatestAny(store, key);
    if (current === undefined || !isLive(current, now)) {
      return 'not-found';
    }
    await this.markLatestDeleted(store, key, current, now);
    await this.markHistoryDeleted(store, key, now);
    return 'deleted';
  }

  async softDeleteStoreContents(store: StoreName, now: Date): Promise<void> {
    // Enumerate ALL latest records (any liveness) — that is the full key set,
    // and dead keys may still need their history checked.
    const rawLatest = await this.collectRaw(
      {
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': latestPk(store) },
      },
      undefined,
      Number.MAX_SAFE_INTEGER,
    );
    for (const item of rawLatest) {
      const record = toLatestRecord(store, item as unknown as RawLatestItem);
      if (isLive(record, now)) {
        await this.markLatestDeleted(store, record.key, record, now);
      }
      await this.markHistoryDeleted(store, record.key, now);
    }
  }

  private async markLatestDeleted(
    store: StoreName,
    key: ItemKey,
    current: LatestItemRecord,
    now: Date,
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: latestPk(store), sk: key },
        UpdateExpression: 'SET deletedAt = :deletedAt, #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':deletedAt': now.toISOString(),
          ':ttl': cappedDeletionTtl(now, current.ttl),
        },
      }),
    );
  }

  private async markHistoryDeleted(store: StoreName, key: ItemKey, now: Date): Promise<void> {
    const raw = await this.collectRaw(
      {
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: LIVE_FILTER,
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': historyPk(store, key), ':now': toEpochSeconds(now) },
      },
      undefined,
      Number.MAX_SAFE_INTEGER,
    );
    for (const batch of chunk(raw, UPDATE_BATCH_SIZE)) {
      await Promise.all(
        batch.map((item) => {
          const entry = item as unknown as RawHistoryItem;
          return this.client.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: { pk: historyPk(store, key), sk: entry.sk },
              UpdateExpression: 'SET deletedAt = :deletedAt, #ttl = :ttl',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: {
                ':deletedAt': now.toISOString(),
                ':ttl': cappedDeletionTtl(now, entry.ttl),
              },
            }),
          );
        }),
      );
    }
  }

  /** Pages through a Query until `max` items are collected or data runs out. */
  private async collectRaw(
    input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
    exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'],
    max: number,
  ): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let startKey = exclusiveStartKey;
    for (;;) {
      const output = await this.client.send(
        new QueryCommand({ TableName: this.tableName, ...input, ExclusiveStartKey: startKey }),
      );
      for (const item of output.Items ?? []) {
        collected.push(item);
        if (collected.length >= max) {
          return collected;
        }
      }
      if (output.LastEvaluatedKey === undefined) {
        return collected;
      }
      startKey = output.LastEvaluatedKey;
    }
  }
}
