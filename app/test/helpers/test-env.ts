import type { Clock } from '../../src/application/ports/clock.js';
import type { IdGenerator } from '../../src/application/ports/id-generator.js';
import { buildHandlers } from '../../src/composition/root.js';
import { InMemoryStorage } from '../../src/infrastructure/in-memory/in-memory-storage.js';
import { JcsContentHasher } from '../../src/infrastructure/jcs-content-hasher.js';

export const TEST_EPOCH = new Date('2026-07-18T12:00:00.000Z');

const MILLISECONDS_PER_DAY = 86_400_000;

/** Deterministic, manually advanced clock. */
export class TestClock implements Clock {
  private current: Date;

  constructor(start: Date = TEST_EPOCH) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * MILLISECONDS_PER_DAY);
  }
}

/**
 * Deterministic stand-in for ULIDs: 26 chars, lexicographically ordered by
 * (time, counter) — the only property the storage contract relies on.
 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  nextUlid(time: Date): string {
    this.counter += 1;
    const timePart = time.getTime().toString(36).padStart(10, '0');
    const counterPart = this.counter.toString(36).padStart(16, '0');
    return `${timePart}${counterPart}`;
  }
}

/** All handlers wired through the real composition root onto in-memory storage. */
export function buildTestEnv() {
  const storage = new InMemoryStorage();
  const clock = new TestClock();
  const ids = new SequentialIdGenerator();
  const hasher = new JcsContentHasher();
  return {
    storage,
    clock,
    ids,
    hasher,
    ...buildHandlers({ stores: storage, items: storage, hasher, clock, ids }),
  };
}
