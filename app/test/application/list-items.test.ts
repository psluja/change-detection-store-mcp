import { describe, expect, it } from 'vitest';

import { InvalidCursorError, StoreNotFoundError } from '../../src/domain/errors.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('list_items', () => {
  it('lists item metas ordered by key, without values', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|2', value: 2 });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });

    const result = await env.listItems.execute({ store: 'prices' });
    expect(result.items.map((item) => item.key)).toEqual(['offer|1', 'offer|2']);
    expect(result.items[0]).toEqual({
      key: 'offer|1',
      date: env.clock.now().toISOString(),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it('excludes soft-deleted items', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.patchItem.execute({ store: 'prices', key: 'offer|2', value: 2 });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });

    const result = await env.listItems.execute({ store: 'prices' });
    expect(result.items.map((item) => item.key)).toEqual(['offer|2']);
  });

  it('pages through more than 100 items with a cursor', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    for (let index = 0; index < 120; index += 1) {
      const key = `key|${index.toString().padStart(3, '0')}`;
      await env.patchItem.execute({ store: 'prices', key, value: index });
    }

    const first = await env.listItems.execute({ store: 'prices' });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();

    const second = await env.listItems.execute({ store: 'prices', cursor: first.nextCursor });
    expect(second.items).toHaveLength(20);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items[0]?.key).toBe('key|100');
  });

  it('rejects a malformed cursor', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(
      env.listItems.execute({ store: 'prices', cursor: 'not-a-cursor' }),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('rejects an unknown store', async () => {
    const env = buildTestEnv();
    await expect(env.listItems.execute({ store: 'nostore' })).rejects.toThrow(StoreNotFoundError);
  });
});
