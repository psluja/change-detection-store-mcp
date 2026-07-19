import { describe, expect, it } from 'vitest';

import { StoreNotFoundError } from '../../src/domain/errors.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('get_item', () => {
  it('returns the latest value with its meta and found: true', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    const patched = await env.patchItem.execute({
      store: 'prices',
      key: 'offer|1',
      value: { price: 100 },
    });

    const result = await env.getItem.execute({ store: 'prices', key: 'offer|1' });
    expect(result).toEqual({
      found: true,
      value: { price: 100 },
      hash: patched.hash,
      date: patched.date,
    });
  });

  it('returns found: false for a key that has no value yet (a normal state)', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toEqual({
      found: false,
    });
  });

  it('returns found: false for a soft-deleted item', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });
    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toEqual({
      found: false,
    });
  });

  it('rejects an unknown store (misconfiguration, unlike a missing key)', async () => {
    const env = buildTestEnv();
    await expect(env.getItem.execute({ store: 'nostore', key: 'offer|1' })).rejects.toThrow(
      StoreNotFoundError,
    );
  });
});
