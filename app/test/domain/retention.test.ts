import { describe, expect, it } from 'vitest';

import {
  cappedDeletionTtl,
  historyTtl,
  isLive,
  toEpochSeconds,
} from '../../src/domain/retention.js';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const NOW_EPOCH = toEpochSeconds(NOW);
const DAY = 86_400;

describe('historyTtl', () => {
  it('is exactly 30 days after creation', () => {
    expect(historyTtl(NOW)).toBe(NOW_EPOCH + 30 * DAY);
  });
});

describe('cappedDeletionTtl', () => {
  it('is 7 days from now when the record had no TTL', () => {
    expect(cappedDeletionTtl(NOW, undefined)).toBe(NOW_EPOCH + 7 * DAY);
  });

  it('never extends a TTL that expires sooner than the cap', () => {
    const soon = NOW_EPOCH + 5 * DAY;
    expect(cappedDeletionTtl(NOW, soon)).toBe(soon);
  });

  it('shortens a TTL that expires later than the cap', () => {
    const far = NOW_EPOCH + 30 * DAY;
    expect(cappedDeletionTtl(NOW, far)).toBe(NOW_EPOCH + 7 * DAY);
  });
});

describe('isLive', () => {
  it('is true without markers', () => {
    expect(isLive({}, NOW)).toBe(true);
  });

  it('is false when soft-deleted', () => {
    expect(isLive({ deletedAt: NOW.toISOString() }, NOW)).toBe(false);
  });

  it('is false when the TTL has passed but the record still physically exists', () => {
    expect(isLive({ ttl: NOW_EPOCH - 1 }, NOW)).toBe(false);
    expect(isLive({ ttl: NOW_EPOCH }, NOW)).toBe(false);
  });

  it('is true when the TTL is still in the future', () => {
    expect(isLive({ ttl: NOW_EPOCH + 1 }, NOW)).toBe(true);
  });
});
