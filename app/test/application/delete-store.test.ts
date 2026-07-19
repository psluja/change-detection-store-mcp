import { describe, expect, it } from 'vitest';

import { StoreNotFoundError } from '../../src/domain/errors.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('delete_store', () => {
  it('hides the store and blocks item access', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });

    await env.deleteStore.execute({ name: 'prices' });

    const stores = await env.listStores.execute();
    expect(stores.stores).toEqual([]);
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).rejects.toThrow(
      StoreNotFoundError,
    );
  });

  it('marks the registry record, all latest records and all history entries', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.patchItem.execute({ store: 'prices', key: 'offer|2', value: 1 });
    await env.patchItem.execute({ store: 'prices', key: 'offer|2', value: 2 });

    await env.deleteStore.execute({ name: 'prices' });

    const { stores, latest, history } = env.storage.snapshot();
    for (const record of [...stores, ...latest, ...history]) {
      expect(record.deletedAt).toBeDefined();
      expect(record.ttl).toBeDefined();
    }
  });

  it('rejects an unknown store', async () => {
    const env = buildTestEnv();
    await expect(env.deleteStore.execute({ name: 'nostore' })).rejects.toThrow(StoreNotFoundError);
  });
});
