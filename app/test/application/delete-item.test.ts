import { describe, expect, it } from 'vitest';

import { ItemNotFoundError } from '../../src/domain/errors.js';
import { toEpochSeconds } from '../../src/domain/retention.js';
import { buildTestEnv } from '../helpers/test-env.js';

const DAY = 86_400;

describe('delete_item', () => {
  it('hides the item and its history from reads', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });

    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });

    await expect(env.getItem.execute({ store: 'prices', key: 'offer|1' })).resolves.toEqual({
      found: false,
    });
    const history = await env.getItemHistory.execute({ store: 'prices', key: 'offer|1' });
    expect(history.entries).toEqual([]);
  });

  it('marks all records with deletedAt and a TTL of at most 7 days', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });

    const cap = toEpochSeconds(env.clock.now()) + 7 * DAY;
    const { latest, history } = env.storage.snapshot();
    for (const record of [...latest, ...history]) {
      expect(record.deletedAt).toBeDefined();
      expect(record.ttl).toBeLessThanOrEqual(cap);
    }
  });

  it('never extends the TTL of a history entry that expires sooner', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    const originalTtl = toEpochSeconds(env.clock.now()) + 30 * DAY;

    env.clock.advanceDays(25); // old entry now expires in 5 days — sooner than the 7-day cap
    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 2 });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });

    const { history } = env.storage.snapshot();
    const ttls = history.map((entry) => entry.ttl).sort((a, b) => a - b);
    expect(ttls).toEqual([
      originalTtl, // untouched: min(t0 + 30d, t0 + 25d + 7d) = t0 + 30d
      toEpochSeconds(env.clock.now()) + 7 * DAY, // fresh entry capped to now + 7d
    ]);
  });

  it('rejects an unknown or already deleted item', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await expect(env.deleteItem.execute({ store: 'prices', key: 'offer|1' })).rejects.toThrow(
      ItemNotFoundError,
    );

    await env.patchItem.execute({ store: 'prices', key: 'offer|1', value: 1 });
    await env.deleteItem.execute({ store: 'prices', key: 'offer|1' });
    await expect(env.deleteItem.execute({ store: 'prices', key: 'offer|1' })).rejects.toThrow(
      ItemNotFoundError,
    );
  });
});
