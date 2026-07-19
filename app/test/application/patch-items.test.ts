import { describe, expect, it } from 'vitest';

import { StoreNotFoundError } from '../../src/domain/errors.js';
import { buildTestEnv } from '../helpers/test-env.js';

describe('patch_items (batch)', () => {
  it('applies all items and returns per-key results in input order', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });

    const result = await env.patchItems.execute({
      store: 'prices',
      items: [
        { key: 'ext|ID6HfGma', value: { price: 100 } }, // case-sensitive key
        { key: 'offer|2', value: { price: 200 } },
        { key: 'offer|3', value: { price: 300 } },
      ],
    });

    expect(result.results.map((entry) => entry.key)).toEqual([
      'ext|ID6HfGma',
      'offer|2',
      'offer|3',
    ]);
    for (const entry of result.results) {
      expect(entry).toMatchObject({ changed: true });
    }
  });

  it('detects per-key changes on a re-run (unchanged values write nothing)', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });
    await env.patchItems.execute({
      store: 'prices',
      items: [
        { key: 'offer|1', value: { price: 100, tags: ['a'] } },
        { key: 'offer|2', value: { price: 200 } },
      ],
    });

    const rerun = await env.patchItems.execute({
      store: 'prices',
      items: [
        { key: 'offer|1', value: { tags: ['a'], price: 100 } }, // same content, reordered keys
        { key: 'offer|2', value: { price: 250 } }, // real change
      ],
    });

    expect(rerun.results).toEqual([
      expect.objectContaining({ key: 'offer|1', changed: false }),
      expect.objectContaining({ key: 'offer|2', changed: true }),
    ]);
    expect(env.storage.snapshot().history).toHaveLength(3); // 2 initial + 1 real change
  });

  it('turns a single bad item into a per-key error without failing the batch', async () => {
    const env = buildTestEnv();
    await env.createStore.execute({ name: 'prices' });

    const result = await env.patchItems.execute({
      store: 'prices',
      items: [
        { key: 'offer|1', value: 1 },
        { key: 'offer|2', value: { blob: 'x'.repeat(64 * 1024) } }, // too large
        { key: 'a#b', value: 3 }, // invalid key
        { key: 'offer|4', value: 4 },
      ],
    });

    expect(result.results[0]).toMatchObject({ key: 'offer|1', changed: true });
    expect(result.results[1]).toMatchObject({
      key: 'offer|2',
      error: expect.stringMatching(/^VALUE_TOO_LARGE: /) as unknown,
    });
    expect(result.results[2]).toMatchObject({
      key: 'a#b',
      error: expect.stringMatching(/^INVALID_ITEM_KEY: /) as unknown,
    });
    expect(result.results[3]).toMatchObject({ key: 'offer|4', changed: true });
  });

  it('fails the whole batch for a missing store (would repeat for every item)', async () => {
    const env = buildTestEnv();
    await expect(
      env.patchItems.execute({ store: 'nostore', items: [{ key: 'offer|1', value: 1 }] }),
    ).rejects.toThrow(StoreNotFoundError);
  });
});
