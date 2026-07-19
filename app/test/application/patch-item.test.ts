import { describe, expect, it } from 'vitest';

import type { ItemRepository } from '../../src/application/ports/item-repository.js';
import { PatchItemHandler } from '../../src/application/patch-item/handler.js';
import {
  ConcurrentModificationError,
  InvalidItemKeyError,
  StoreNotFoundError,
  ValueTooLargeError,
} from '../../src/domain/errors.js';
import { historyTtl } from '../../src/domain/retention.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('patch_item', () => {
  it('writes the first value as a change and appends history with a 30-day TTL', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const result = await env.patchItem.execute({
      store: 'prices',
      key: 'source|43533322',
      value: { price: 100 },
    });

    expect(result.changed).toBe(true);
    const { history } = env.storage.snapshot();
    expect(history).toHaveLength(1);
    expect(history[0]?.ttl).toBe(historyTtl(env.clock.now()));
  });

  it('reports no change for the same value with different key order', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const first = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 100, tags: ['new', 'promo'] },
    });
    const second = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { tags: ['new', 'promo'], price: 100 },
    });

    expect(second.changed).toBe(false);
    expect(second.hash).toBe(first.hash);
    expect(second.date).toBe(first.date);
    expect(env.storage.snapshot().history).toHaveLength(1);
  });

  it('treats array reordering as a change', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { tags: [1, 2] } });
    const result = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { tags: [2, 1] },
    });
    expect(result.changed).toBe(true);
  });

  it('records every change in history', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 1 } });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 2 } });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 2 } });
    expect(env.storage.snapshot().history).toHaveLength(2);
  });

  it('rejects a missing store', async () => {
    const env = buildTestEnv();
    await expect(
      env.patchItem.execute({ store: 'nostore', key: 'offer|1', value: 1 }),
    ).rejects.toThrow(StoreNotFoundError);
  });

  it('rejects an invalid key', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(
      env.patchItem.execute({ store: 'prices', key: 'Offer#1', value: 1 }),
    ).rejects.toThrow(InvalidItemKeyError);
  });

  it('rejects a value above 64 KB after canonicalization', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(
      env.patchItem.execute({
        store: 'prices',
        key: 'offer|1',
        value: { blob: 'x'.repeat(64 * 1024) },
      }),
    ).rejects.toThrow(ValueTooLargeError);
  });

  it('starts a fresh life for a soft-deleted key', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 1 } });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });

    const result = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 1 },
    });
    expect(result.changed).toBe(true);
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toMatchObject({
      value: { price: 1 },
    });
  });

  it('persists meta on every call, outside change detection', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });

    // First write with meta.
    await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 100 },
      meta: { lastSeenAt: '2026-07-19T08:00:00Z' },
    });
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toMatchObject({
      meta: { lastSeenAt: '2026-07-19T08:00:00Z' },
    });

    // Unchanged value + new meta: changed=false, no history entry, meta replaced.
    const unchanged = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 100 },
      meta: { lastSeenAt: '2026-07-19T09:00:00Z' },
    });
    expect(unchanged.changed).toBe(false);
    expect(env.storage.snapshot().history).toHaveLength(1);
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toMatchObject({
      meta: { lastSeenAt: '2026-07-19T09:00:00Z' },
    });

    // Unchanged value, no meta given: previous meta stays.
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 100 } });
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toMatchObject({
      meta: { lastSeenAt: '2026-07-19T09:00:00Z' },
    });
  });

  it('snapshots meta into history entries on real changes', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 1 },
      meta: { seen: 1 },
    });
    await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 2 },
      meta: { seen: 2 },
    });

    const history = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1' });
    expect(history.entries.map((entry) => entry.meta)).toEqual([{ seen: 2 }, { seen: 1 }]);
  });

  it('rejects meta above 64 KB', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(
      env.patchItem.execute({
        store: 'prices',
        key: 'offer|1',
        value: 1,
        meta: { blob: 'x'.repeat(64 * 1024) },
      }),
    ).rejects.toThrow(ValueTooLargeError);
  });

  it('retries on a commit conflict and eventually succeeds', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const flaky = conflictingRepository(env.storage, 2);
    const handler = new PatchItemHandler(env.storage, flaky, env.hasher, env.clock, env.ids);

    const result = await handler.execute({ store: 'prices', key: 'offer|1', value: 1 });
    expect(result.changed).toBe(true);
  });

  it('gives up after persistent conflicts', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const flaky = conflictingRepository(env.storage, Number.POSITIVE_INFINITY);
    const handler = new PatchItemHandler(env.storage, flaky, env.hasher, env.clock, env.ids);

    await expect(handler.execute({ store: 'prices', key: 'offer|1', value: 1 })).rejects.toThrow(
      ConcurrentModificationError,
    );
  });
});

/** Delegates to the real repository but fails the first `conflicts` commits. */
function conflictingRepository(inner: ItemRepository, conflicts: number): ItemRepository {
  let remaining = conflicts;
  return {
    ...inner,
    findLatestAny: (store, key) => inner.findLatestAny(store, key),
    commitChange: (latest, history, expectedHash, now) => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.resolve('conflict' as const);
      }
      return inner.commitChange(latest, history, expectedHash, now);
    },
    updateLatestMeta: (store, key, expectedHash, meta, now) =>
      inner.updateLatestMeta(store, key, expectedHash, meta, now),
    listLatestLive: (store, now, limit, cursor) => inner.listLatestLive(store, now, limit, cursor),
    listHistoryLive: (store, key, now, limit, cursor) =>
      inner.listHistoryLive(store, key, now, limit, cursor),
    softDeleteItem: (store, key, now) => inner.softDeleteItem(store, key, now),
    softDeleteStoreContents: (store, now) => inner.softDeleteStoreContents(store, now),
  };
}
