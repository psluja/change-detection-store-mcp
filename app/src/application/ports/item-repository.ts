import type { ContentHash } from '../../domain/content-hash.js';
import type { ItemKey } from '../../domain/item-key.js';
import type { JsonValue } from '../../domain/json.js';
import type { HistoryEntryRecord, LatestItemRecord } from '../../domain/records.js';
import type { StoreName } from '../../domain/store-name.js';

export interface Page<T> {
  readonly items: readonly T[];
  /** Present when more results exist; opaque, adapter-specific encoding. */
  readonly nextCursor?: string;
}

/**
 * Persistence port for item state and history. "Live" follows the domain
 * liveness rule (see domain/retention.ts); soft deletes apply the capped
 * deletion TTL rule per record.
 */
export interface ItemRepository {
  /** Returns the latest record regardless of liveness (soft-deleted/expired included). */
  findLatestAny(store: StoreName, key: ItemKey): Promise<LatestItemRecord | undefined>;

  /**
   * Atomically writes the new latest state and appends the history entry,
   * guarded twice: `expectedHash` is the optimistic-concurrency guard (hash of
   * the live latest record the caller saw, or null when it saw none), and the
   * owning store must still be live — otherwise a patch racing a store delete
   * would leave an immortal live record inside a dead store, resurfacing after
   * name reactivation. Returns 'conflict' when the hash guard no longer holds
   * and 'store-missing' when the store guard fails.
   */
  commitChange(
    latest: LatestItemRecord,
    history: HistoryEntryRecord,
    expectedHash: ContentHash | null,
    now: Date,
  ): Promise<'committed' | 'conflict' | 'store-missing'>;

  /**
   * Replaces ONLY the sidecar meta of a live latest record whose hash still
   * equals `expectedHash` — the unchanged-value path of a patch carrying meta.
   * Never touches hash/date and never appends history. Returns 'conflict'
   * when the record is gone, dead, or its value changed concurrently.
   */
  updateLatestMeta(
    store: StoreName,
    key: ItemKey,
    expectedHash: ContentHash,
    meta: JsonValue,
    now: Date,
  ): Promise<'updated' | 'conflict'>;

  /** Pages through live latest records of a store, ordered by key. */
  listLatestLive(
    store: StoreName,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<LatestItemRecord>>;

  /** Pages through live history entries of a key, newest first. */
  listHistoryLive(
    store: StoreName,
    key: ItemKey,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<HistoryEntryRecord>>;

  /** Soft-deletes the live latest record and all history entries of a key. */
  softDeleteItem(store: StoreName, key: ItemKey, now: Date): Promise<'deleted' | 'not-found'>;

  /** Soft-deletes every live latest record and history entry in a store. */
  softDeleteStoreContents(store: StoreName, now: Date): Promise<void>;
}
