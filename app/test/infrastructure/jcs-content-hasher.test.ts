import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../../src/domain/json.js';
import { JcsContentHasher } from '../../src/infrastructure/jcs-content-hasher.js';

const hasher = new JcsContentHasher();

function hashOf(value: JsonValue): string {
  return hasher.hash(value).hash;
}

describe('JcsContentHasher', () => {
  it('produces a SHA-256 hex digest', () => {
    expect(hashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores object key order, recursively', () => {
    expect(hashOf({ a: 1, b: [1, 2], c: { x: true, y: null } })).toBe(
      hashOf({ c: { y: null, x: true }, b: [1, 2], a: 1 }),
    );
  });

  it('normalizes number representations the way ES numbers do', () => {
    // 1.0, 1e0 and 1 are the same JS number after JSON parsing.
    expect(hashOf({ n: JSON.parse('1.0') as JsonValue })).toBe(hashOf({ n: 1 }));
    expect(hashOf({ n: JSON.parse('1e2') as JsonValue })).toBe(hashOf({ n: 100 }));
  });

  it('treats array order as significant', () => {
    expect(hashOf([1, 2])).not.toBe(hashOf([2, 1]));
  });

  it('distinguishes types', () => {
    expect(hashOf({ v: '1' })).not.toBe(hashOf({ v: 1 }));
    expect(hashOf({ v: null })).not.toBe(hashOf({ v: false }));
  });

  it('counts canonical UTF-8 bytes, not characters', () => {
    // Canonical form: {"a":"ż"} — 9 characters, "ż" is 2 bytes in UTF-8.
    expect(hasher.hash({ a: 'ż' }).canonicalByteLength).toBe(10);
    expect(hasher.hash({ b: 1, a: 'x' }).canonicalByteLength).toBe('{"a":"x","b":1}'.length);
  });

  it('rejects non-JSON input that canonicalizes to nothing', () => {
    expect(() => hasher.hash(undefined as unknown as JsonValue)).toThrow();
  });
});
