import { ConcurrentModificationError } from '../../domain/errors.js';
import { parseStoreName } from '../../domain/store-name.js';
import type { Clock } from '../ports/clock.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { CreateStoreCommand, CreateStoreResult } from './command.js';

const MAX_ATTEMPTS = 3;

/**
 * Idempotent (upsert semantics): every agent run may call this on startup.
 * An existing live store is returned as-is with `created: false`; a missing
 * or soft-deleted name is (re)created as an empty store with `created: true`.
 */
export class CreateStoreHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateStoreCommand): Promise<CreateStoreResult> {
    const name = parseStoreName(command.name);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = this.clock.now();
      const record = { name, createdAt: now.toISOString() };
      const outcome = await this.stores.createOrReactivate(record, now);
      if (outcome === 'created') {
        return { ...record, created: true };
      }
      const existing = await this.stores.findLive(name, now);
      if (existing !== undefined) {
        return { name, createdAt: existing.createdAt, created: false };
      }
      // The store died between the two calls (raced a delete) — try again.
    }
    throw new ConcurrentModificationError(name);
  }
}
