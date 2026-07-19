import { monotonicFactory } from 'ulid';

import type { IdGenerator } from '../application/ports/id-generator.js';

/** Monotonic ULIDs: same-millisecond calls still sort in generation order. */
export class UlidIdGenerator implements IdGenerator {
  private readonly generate = monotonicFactory();

  nextUlid(time: Date): string {
    return this.generate(time.getTime());
  }
}
