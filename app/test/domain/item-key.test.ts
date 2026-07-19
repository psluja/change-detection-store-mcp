import { describe, expect, it } from 'vitest';

import { InvalidItemKeyError } from '../../src/domain/errors.js';
import { parseItemKey } from '../../src/domain/item-key.js';

describe('parseItemKey', () => {
  it.each([
    'abc',
    'source|43533322', // pipe-separated external id
    'source|ID6HfGma', // case-sensitive external id
    'a-b_c|d',
    'k'.repeat(32),
  ])('accepts %j', (raw) => {
    expect(parseItemKey(raw)).toBe(raw);
  });

  it('preserves case (no lowercasing that could collide external IDs)', () => {
    expect(parseItemKey('ext|ID6HfGma')).toBe('ext|ID6HfGma');
    expect(parseItemKey('ext|id6hfgma')).not.toBe(parseItemKey('ext|ID6HfGma'));
  });

  it.each([
    '',
    'ab', // too short
    'k'.repeat(33), // too long
    'a b', // space
    'a#b', // composite-key separator
    'żółć', // non-ASCII
  ])('rejects %j', (raw) => {
    expect(() => parseItemKey(raw)).toThrow(InvalidItemKeyError);
  });
});
