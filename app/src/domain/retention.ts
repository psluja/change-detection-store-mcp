import type { LifecycleAttributes } from './records.js';

export const HISTORY_RETENTION_DAYS = 30;
export const DELETION_GRACE_DAYS = 7;

const SECONDS_PER_DAY = 86_400;

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** TTL for a new history entry: creation time + 30 days. */
export function historyTtl(createdAt: Date): number {
  return toEpochSeconds(createdAt) + HISTORY_RETENTION_DAYS * SECONDS_PER_DAY;
}

/**
 * TTL applied by soft delete: at most 7 days from now, never extending
 * a record that would expire sooner anyway.
 */
export function cappedDeletionTtl(now: Date, existingTtl: number | undefined): number {
  const cap = toEpochSeconds(now) + DELETION_GRACE_DAYS * SECONDS_PER_DAY;
  return existingTtl === undefined ? cap : Math.min(existingTtl, cap);
}

/**
 * A record is live when it is not soft-deleted and its TTL (if any) has not
 * passed. DynamoDB removes expired records with up to ~48 h delay, so reads
 * must apply this rule instead of trusting physical presence.
 */
export function isLive(record: LifecycleAttributes, now: Date): boolean {
  return (
    record.deletedAt === undefined && (record.ttl === undefined || record.ttl > toEpochSeconds(now))
  );
}
