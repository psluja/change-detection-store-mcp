import { describe, expect, it } from 'vitest';

import { InvalidStoreNameError } from '../../src/domain/errors.js';
import { parseStoreName } from '../../src/domain/store-name.js';

describe('parseStoreName', () => {
  it.each(['abc', 'a-b', 'a_b', '0-9', 'abcdefghijkl', 'store_1'])('accepts %j', (raw) => {
    expect(parseStoreName(raw)).toBe(raw);
  });

  it.each([
    '',
    'ab', // too short
    'abcdefghijklm', // 13 chars, too long
    'ABC', // uppercase
    'a b', // space
    'a|b', // pipe is key-only
    'a#b', // composite-key separator
    'ąbć', // non-ASCII
  ])('rejects %j', (raw) => {
    expect(() => parseStoreName(raw)).toThrow(InvalidStoreNameError);
  });
});
