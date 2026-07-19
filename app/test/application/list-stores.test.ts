import { describe, expect, it } from 'vitest';

import { buildTestEnv } from '../helpers/test-env.js';

describe('list_stores', () => {
  it('returns an empty list when nothing exists', async () => {
    const env = buildTestEnv();
    await expect(env.listStores.execute()).resolves.toEqual({ stores: [] });
  });

  it('lists live stores ordered by name', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'zebra' });
    await env.createStore.execute({ name: 'alpha' });
    const result = await env.listStores.execute();
    expect(result.stores.map((store) => store.name)).toEqual(['alpha', 'zebra']);
  });

  it('hides soft-deleted stores', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'alpha' });
    await env.createStore.execute({ name: 'zebra' });
    await env.deleteStore.execute({ name: 'alpha' });
    const result = await env.listStores.execute();
    expect(result.stores.map((store) => store.name)).toEqual(['zebra']);
  });
});
