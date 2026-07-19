import type { StoreRecord } from '../../domain/records.js';
import type { StoreName } from '../../domain/store-name.js';

/**
 * Persistence port for the store registry. Implementations return only
 * records that satisfy the domain liveness rule where the contract says
 * "live" (see domain/retention.ts).
 */
export interface StoreRepository {
  /**
   * Creates the store, or reactivates it when only a soft-deleted or expired
   * record occupies the name. Returns 'already-exists' when a live store has
   * the name.
   */
  createOrReactivate(record: StoreRecord, now: Date): Promise<'created' | 'already-exists'>;

  /** Returns the live store record, or undefined. */
  findLive(name: StoreName, now: Date): Promise<StoreRecord | undefined>;

  /** Lists live store records ordered by name. */
  listLive(now: Date): Promise<StoreRecord[]>;

  /** Soft-deletes a live store record (deletedAt + capped TTL). */
  softDelete(name: StoreName, now: Date): Promise<'deleted' | 'not-found'>;
}
