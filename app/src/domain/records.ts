import type { ContentHash } from './content-hash.js';
import type { ItemKey } from './item-key.js';
import type { JsonValue } from './json.js';
import type { StoreName } from './store-name.js';

/** Soft-delete and expiry markers shared by all stored records. */
export interface LifecycleAttributes {
  /** ISO-8601 timestamp set by soft delete; a marked record is invisible to reads. */
  readonly deletedAt?: string;
  /** DynamoDB TTL: epoch seconds after which the record is physically removed. */
  readonly ttl?: number;
}

export interface StoreRecord extends LifecycleAttributes {
  readonly name: StoreName;
  readonly createdAt: string;
}

export interface LatestItemRecord extends LifecycleAttributes {
  readonly store: StoreName;
  readonly key: ItemKey;
  readonly hash: ContentHash;
  readonly date: string;
  readonly value: JsonValue;
  /**
   * Client-owned sidecar JSON, OUTSIDE change detection: written on every
   * patch (even when the value is unchanged), never hashed, replaced whole.
   */
  readonly meta?: JsonValue;
}

export interface HistoryEntryRecord extends LifecycleAttributes {
  readonly store: StoreName;
  readonly key: ItemKey;
  /** ULID; lexicographic order equals chronological order. */
  readonly id: string;
  readonly hash: ContentHash;
  readonly date: string;
  readonly value: JsonValue;
  /** Snapshot of the sidecar meta passed with THE patch that recorded this change. */
  readonly meta?: JsonValue;
  /** History entries always expire: creation date + 30 days (soft delete may shorten). */
  readonly ttl: number;
}
