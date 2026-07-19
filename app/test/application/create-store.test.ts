import { describe, expect, it } from 'vitest';

import { InvalidStoreNameError } from '../../src/domain/errors.js';
import { buildTestEnv, TEST_EPOCH } from '../helpers/test-env.js';

describe('create_store', () => {
  it('creates a store and reports created: true', async () => {
    const env = buildTestEnv();
    const result = await env.createStore.execute({ name: 'prices' });
    expect(result).toEqual({ name: 'prices', createdAt: TEST_EPOCH.toISOString(), created: true });
  });

  it('is idempotent: an existing store is returned with its original createdAt', async () => {
    const env = buildTestEnv();
    const first = await env.createStore.execute({ name: 'prices' });
    env.clock.advanceDays(3);

    const second = await env.createStore.execute({ name: 'prices' });
    expect(second).toEqual({ name: 'prices', createdAt: first.createdAt, created: false });
  });

  it('rejects invalid names', async () => {
    const env = buildTestEnv();
    await expect(env.createStore.execute({ name: 'Prices' })).rejects.toThrow(
      InvalidStoreNameError,
    );
  });

  it('reactivates a soft-deleted name as a fresh, empty store (created: true)', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: { price: 10 } });
    await env.deleteStore.execute({ name: 'prices' });

    const recreated = await env.createStore.execute({ name: 'prices' });
    expect(recreated.created).toBe(true);

    // Old contents stay soft-deleted: the reactivated store starts empty.
    const listed = await env.listItems.execute({ store: 'prices' });
    expect(listed.items).toEqual([]);
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toEqual({
      found: false,
    });
  });
});
