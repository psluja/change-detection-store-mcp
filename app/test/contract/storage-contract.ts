import { describe, beforeAll, afterAll, expect, it } from 'vitest';

import type { ItemRepository } from '../../src/application/ports/item-repository.js';
import type { StoreRepository } from '../../src/application/ports/store-repository.js';
import { asContentHash } from '../../src/domain/content-hash.js';
import type { ContentHash } from '../../src/domain/content-hash.js';
import { InvalidCursorError } from '../../src/domain/errors.js';
import { parseItemKey } from '../../src/domain/item-key.js';
import type { ItemKey } from '../../src/domain/item-key.js';
import type { JsonValue } from '../../src/domain/json.js';
import type { HistoryEntryRecord, LatestItemRecord } from '../../src/domain/records.js';
import { historyTtl, toEpochSeconds } from '../../src/domain/retention.js';
import { parseStoreName } from '../../src/domain/store-name.js';
import type { StoreName } from '../../src/domain/store-name.js';
import { encodeCursor } from '../../src/infrastructure/pagination-cursor.js';
import { SequentialIdGenerator } from '../helpers/test-env.js';

export interface StorageUnderTest {
  readonly stores: StoreRepository;
  readonly items: ItemRepository;
  readonly teardown?: (() => Promise<void>) | undefined;
}

export interface StorageContractOptions {
  readonly name: string;
  readonly createStorage: () => Promise<StorageUnderTest>;
}

const NOW = new Date('2026-07-18T12:00:00.000Z');
const DAY = 86_400;

const HASH_A = asContentHash('a'.repeat(64));
const HASH_B = asContentHash('b'.repeat(64));
const HASH_C = asContentHash('c'.repeat(64));

/**
 * Port-level contract every storage adapter must satisfy. Runs against the
 * in-memory adapter (unit) and the DynamoDB adapter (integration) — one
 * contract, zero drift between implementations.
 */
export function describeStorageContract({ name, createStorage }: StorageContractOptions): void {
  describe(`storage contract: ${name}`, () => {
    let storage: StorageUnderTest;
    const ids = new SequentialIdGenerator();
    let sequence = 0;

    beforeAll(async () => {
      storage = await createStorage();
    });

    afterAll(async () => {
      await storage.teardown?.();
    });

    /** Unique per test — the suite shares one storage instance. */
    function uniqueStoreName(): StoreName {
      sequence += 1;
      return parseStoreName(`st-${String(sequence)}`);
    }

    async function seedStore(): Promise<StoreName> {
      const store = uniqueStoreName();
      await storage.stores.createOrReactivate({ name: store, createdAt: NOW.toISOString() }, NOW);
      return store;
    }

    function latestRecord(
      store: StoreName,
      key: ItemKey,
      hash: ContentHash,
      value: JsonValue,
    ): LatestItemRecord {
      return { store, key, hash, date: NOW.toISOString(), value };
    }

    function historyRecord(
      store: StoreName,
      key: ItemKey,
      hash: ContentHash,
      value: JsonValue,
      ttl: number = historyTtl(NOW),
    ): HistoryEntryRecord {
      return { store, key, id: ids.nextUlid(NOW), hash, date: NOW.toISOString(), value, ttl };
    }

    async function commit(
      store: StoreName,
      key: ItemKey,
      hash: ContentHash,
      value: JsonValue,
      expected: ContentHash | null,
      historyTtlOverride?: number,
    ): Promise<'committed' | 'conflict' | 'store-missing'> {
      return storage.items.commitChange(
        latestRecord(store, key, hash, value),
        historyRecord(store, key, hash, value, historyTtlOverride),
        expected,
        NOW,
      );
    }

    describe('store registry', () => {
      it('creates a store and rejects a live duplicate', async () => {
        const store = uniqueStoreName();
        const record = { name: store, createdAt: NOW.toISOString() };
        await expect(storage.stores.createOrReactivate(record, NOW)).resolves.toBe('created');
        await expect(storage.stores.findLive(store, NOW)).resolves.toEqual(record);
        await expect(storage.stores.createOrReactivate(record, NOW)).resolves.toBe(
          'already-exists',
        );
      });

      it('soft delete hides the store; repeat delete reports not-found', async () => {
        const store = uniqueStoreName();
        await storage.stores.createOrReactivate({ name: store, createdAt: NOW.toISOString() }, NOW);
        await expect(storage.stores.softDelete(store, NOW)).resolves.toBe('deleted');
        await expect(storage.stores.findLive(store, NOW)).resolves.toBeUndefined();
        await expect(storage.stores.softDelete(store, NOW)).resolves.toBe('not-found');
      });

      it('reactivates a soft-deleted name as a clean record', async () => {
        const store = uniqueStoreName();
        await storage.stores.createOrReactivate({ name: store, createdAt: NOW.toISOString() }, NOW);
        await storage.stores.softDelete(store, NOW);

        const later = new Date(NOW.getTime() + 1000);
        const fresh = { name: store, createdAt: later.toISOString() };
        await expect(storage.stores.createOrReactivate(fresh, NOW)).resolves.toBe('created');
        await expect(storage.stores.findLive(store, NOW)).resolves.toEqual(fresh);
      });

      it('lists live stores sorted by name', async () => {
        const zebra = uniqueStoreName();
        const alpha = uniqueStoreName();
        await storage.stores.createOrReactivate({ name: zebra, createdAt: NOW.toISOString() }, NOW);
        await storage.stores.createOrReactivate({ name: alpha, createdAt: NOW.toISOString() }, NOW);

        const listed = await storage.stores.listLive(NOW);
        const names = listed.map((record) => record.name);
        expect(names).toEqual([...names].sort());
        expect(names).toContain(zebra);
        expect(names).toContain(alpha);
      });
    });

    describe('commitChange', () => {
      const key = parseItemKey('source|43533322');

      it('commits with a null guard when nothing exists, and round-trips the value', async () => {
        const store = await seedStore();
        const value = { price: 100, tags: ['new', 1, true], nested: { x: null } };
        await expect(commit(store, key, HASH_A, value, null)).resolves.toBe('committed');
        await expect(storage.items.findLatestAny(store, key)).resolves.toEqual(
          latestRecord(store, key, HASH_A, value),
        );
      });

      it('conflicts with a null guard when a live record exists', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await expect(commit(store, key, HASH_B, 2, null)).resolves.toBe('conflict');
      });

      it('commits when the expected hash matches and conflicts when it is stale', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await expect(commit(store, key, HASH_B, 2, HASH_A)).resolves.toBe('committed');
        await expect(commit(store, key, HASH_C, 3, HASH_A)).resolves.toBe('conflict');
        await expect(storage.items.findLatestAny(store, key)).resolves.toMatchObject({ value: 2 });
      });

      it('commits with a null guard over a soft-deleted record, producing a clean one', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await storage.items.softDeleteItem(store, key, NOW);

        await expect(commit(store, key, HASH_B, 2, null)).resolves.toBe('committed');
        await expect(storage.items.findLatestAny(store, key)).resolves.toEqual(
          latestRecord(store, key, HASH_B, 2),
        );
      });

      it('reports store-missing when the owning store is soft-deleted (patch × delete race)', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await storage.stores.softDelete(store, NOW);

        await expect(commit(store, key, HASH_B, 2, HASH_A)).resolves.toBe('store-missing');
        await expect(commit(store, key, HASH_B, 2, null)).resolves.toBe('store-missing');
      });

      it('reports store-missing for a store that never existed', async () => {
        const ghost = uniqueStoreName();
        await expect(commit(ghost, key, HASH_A, 1, null)).resolves.toBe('store-missing');
      });

      it('round-trips the sidecar meta on latest and history records', async () => {
        const store = await seedStore();
        const latest = { ...latestRecord(store, key, HASH_A, 1), meta: { seen: 1 } };
        const history = { ...historyRecord(store, key, HASH_A, 1), meta: { seen: 1 } };
        await expect(storage.items.commitChange(latest, history, null, NOW)).resolves.toBe(
          'committed',
        );
        await expect(storage.items.findLatestAny(store, key)).resolves.toEqual(latest);
        const entries = await storage.items.listHistoryLive(store, key, NOW, 10);
        expect(entries.items[0]?.meta).toEqual({ seen: 1 });
      });
    });

    describe('updateLatestMeta', () => {
      const key = parseItemKey('offer|meta');

      it('replaces only the meta when the hash still matches', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);

        await expect(
          storage.items.updateLatestMeta(store, key, HASH_A, { seen: 2 }, NOW),
        ).resolves.toBe('updated');

        const latest = await storage.items.findLatestAny(store, key);
        expect(latest).toMatchObject({ hash: HASH_A, value: 1, meta: { seen: 2 } });
        expect(latest?.date).toBe(NOW.toISOString());
      });

      it('conflicts on a stale hash, a soft-deleted record and a missing record', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);

        await expect(
          storage.items.updateLatestMeta(store, key, HASH_B, { seen: 1 }, NOW),
        ).resolves.toBe('conflict');

        await storage.items.softDeleteItem(store, key, NOW);
        await expect(
          storage.items.updateLatestMeta(store, key, HASH_A, { seen: 1 }, NOW),
        ).resolves.toBe('conflict');

        await expect(
          storage.items.updateLatestMeta(store, parseItemKey('offer|ghost'), HASH_A, {}, NOW),
        ).resolves.toBe('conflict');
      });
    });

    describe('listLatestLive', () => {
      it('pages live records ordered by key and excludes soft-deleted ones', async () => {
        const store = await seedStore();
        const keys = ['key|1', 'key|2', 'key|3', 'key|4', 'key|5'].map(parseItemKey);
        for (const itemKey of keys) {
          await commit(store, itemKey, HASH_A, 1, null);
        }
        await storage.items.softDeleteItem(store, parseItemKey('key|3'), NOW);

        const first = await storage.items.listLatestLive(store, NOW, 2);
        expect(first.items.map((record) => record.key)).toEqual(['key|1', 'key|2']);
        expect(first.nextCursor).toBeDefined();

        const second = await storage.items.listLatestLive(store, NOW, 2, first.nextCursor);
        expect(second.items.map((record) => record.key)).toEqual(['key|4', 'key|5']);
        expect(second.nextCursor).toBeUndefined();
      });

      it('rejects garbage cursors and cursors from another operation', async () => {
        const store = await seedStore();
        await expect(storage.items.listLatestLive(store, NOW, 2, 'garbage!')).rejects.toThrow(
          InvalidCursorError,
        );
        await expect(
          storage.items.listLatestLive(store, NOW, 2, encodeCursor({ i: 'x' })),
        ).rejects.toThrow(InvalidCursorError);
      });
    });

    describe('listHistoryLive', () => {
      const key = parseItemKey('offer|7');

      it('returns entries newest first and pages with a cursor', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await commit(store, key, HASH_B, 2, HASH_A);
        await commit(store, key, HASH_C, 3, HASH_B);

        const first = await storage.items.listHistoryLive(store, key, NOW, 2);
        expect(first.items.map((entry) => entry.value)).toEqual([3, 2]);
        expect(first.nextCursor).toBeDefined();

        const second = await storage.items.listHistoryLive(store, key, NOW, 2, first.nextCursor);
        expect(second.items.map((entry) => entry.value)).toEqual([1]);
        expect(second.nextCursor).toBeUndefined();
      });

      it('hides entries whose TTL passed even before physical removal', async () => {
        const store = await seedStore();
        const expiredTtl = toEpochSeconds(NOW) - 10;
        await commit(store, key, HASH_A, 1, null, expiredTtl);
        await commit(store, key, HASH_B, 2, HASH_A);

        const page = await storage.items.listHistoryLive(store, key, NOW, 10);
        expect(page.items.map((entry) => entry.value)).toEqual([2]);
      });
    });

    describe('softDeleteItem', () => {
      const key = parseItemKey('offer|9');

      it('marks the latest record and hides the history', async () => {
        const store = await seedStore();
        await commit(store, key, HASH_A, 1, null);
        await commit(store, key, HASH_B, 2, HASH_A);

        await expect(storage.items.softDeleteItem(store, key, NOW)).resolves.toBe('deleted');
        await expect(storage.items.softDeleteItem(store, key, NOW)).resolves.toBe('not-found');

        const latest = await storage.items.findLatestAny(store, key);
        expect(latest?.deletedAt).toBeDefined();
        expect(latest?.ttl).toBeLessThanOrEqual(toEpochSeconds(NOW) + 7 * DAY);

        const history = await storage.items.listHistoryLive(store, key, NOW, 10);
        expect(history.items).toEqual([]);
      });
    });

    describe('softDeleteStoreContents', () => {
      it('marks every item of the store and leaves other stores intact', async () => {
        const doomed = await seedStore();
        const survivor = await seedStore();
        for (const itemKey of [parseItemKey('key|1'), parseItemKey('key|2')]) {
          await commit(doomed, itemKey, HASH_A, 1, null);
          await commit(survivor, itemKey, HASH_A, 1, null);
        }

        await storage.items.softDeleteStoreContents(doomed, NOW);

        const doomedPage = await storage.items.listLatestLive(doomed, NOW, 10);
        expect(doomedPage.items).toEqual([]);
        const doomedHistory = await storage.items.listHistoryLive(
          doomed,
          parseItemKey('key|1'),
          NOW,
          10,
        );
        expect(doomedHistory.items).toEqual([]);

        const survivorPage = await storage.items.listLatestLive(survivor, NOW, 10);
        expect(survivorPage.items.map((record) => record.key)).toEqual(['key|1', 'key|2']);
      });
    });
  });
}
