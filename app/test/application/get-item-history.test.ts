import { describe, expect, it } from 'vitest';

import { StoreNotFoundError } from '../../src/domain/errors.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('get_item_history', () => {
  it('returns entries newest first, only for real changes', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 1 } });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 1 } }); // no change
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 2 } });

    const result = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1' });
    expect(result.entries.map((entry) => entry.value)).toEqual([{ price: 2 }, { price: 1 }]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('drops entries older than the 30-day retention window', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 1 } });

    env.clock.advanceDays(31);
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 2 } });

    const result = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1' });
    expect(result.entries.map((entry) => entry.value)).toEqual([{ price: 2 }]);
  });

  it('paginates with limit and cursor', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    for (let price = 1; price <= 5; price += 1) {
      await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price } });
    }

    const first = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1', limit: 2 });
    expect(first.entries.map((entry) => entry.value)).toEqual([{ price: 5 }, { price: 4 }]);
    expect(first.nextCursor).toBeDefined();

    const second = await env.getItemHistory.execute({
      store: 'prices',
      key: 'offer|1',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.entries.map((entry) => entry.value)).toEqual([{ price: 3 }, { price: 2 }]);
  });

  it('clamps the limit to at least one entry', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 2 });

    const result = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1', limit: 0 });
    expect(result.entries).toHaveLength(1);
  });

  it('returns an empty history for an unknown key in an existing store', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const result = await env.getItemHistory.execute({ store: 'prices', key: 'offer|9' });
    expect(result.entries).toEqual([]);
  });

  it('rejects an unknown store', async () => {
    const env = buildTestEnv();
    await expect(env.getItemHistory.execute({ store: 'nostore', key: 'offer|1' })).rejects.toThrow(
      StoreNotFoundError,
    );
  });
});
