import type { ItemRepository, Page } from '../../application/ports/item-repository.js';
import type { StoreRepository } from '../../application/ports/store-repository.js';
import type { ContentHash } from '../../domain/content-hash.js';
import type { ItemKey } from '../../domain/item-key.js';
import type { JsonValue } from '../../domain/json.js';
import type { HistoryEntryRecord, LatestItemRecord, StoreRecord } from '../../domain/records.js';
import { cappedDeletionTtl, isLive } from '../../domain/retention.js';
import type { StoreName } from '../../domain/store-name.js';
import { encodeCursor, paginate, requireCursorField } from '../pagination-cursor.js';

/** Code-unit string comparison; deliberately not locale-aware. */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** `#` cannot occur in store names or item keys, so this composite is unambiguous. */
function itemId(store: StoreName, key: ItemKey): string {
  return `${store}#${key}`;
}

/**
 * In-memory implementation of both persistence ports. Mirrors the DynamoDB
 * adapter's observable behavior (ordering, opaque cursors, liveness filtering,
 * capped deletion TTL) so application tests exercise the same contract.
 */
export class InMemoryStorage implements StoreRepository, ItemRepository {
  private readonly stores = new Map<string, StoreRecord>();
  private readonly latest = new Map<string, LatestItemRecord>();
  private readonly history = new Map<string, HistoryEntryRecord[]>();

  // --- StoreRepository ---

  createOrReactivate(record: StoreRecord, now: Date): Promise<'created' | 'already-exists'> {
    const existing = this.stores.get(record.name);
    if (existing !== undefined && isLive(existing, now)) {
      return Promise.resolve('already-exists');
    }
    this.stores.set(record.name, { name: record.name, createdAt: record.createdAt });
    return Promise.resolve('created');
  }

  findLive(name: StoreName, now: Date): Promise<StoreRecord | undefined> {
    const record = this.stores.get(name);
    return Promise.resolve(record !== undefined && isLive(record, now) ? record : undefined);
  }

  listLive(now: Date): Promise<StoreRecord[]> {
    const live = [...this.stores.values()]
      .filter((record) => isLive(record, now))
      .sort((a, b) => compareStrings(a.name, b.name));
    return Promise.resolve(live);
  }

  softDelete(name: StoreName, now: Date): Promise<'deleted' | 'not-found'> {
    const record = this.stores.get(name);
    if (record === undefined || !isLive(record, now)) {
      return Promise.resolve('not-found');
    }
    this.stores.set(name, {
      ...record,
      deletedAt: now.toISOString(),
      ttl: cappedDeletionTtl(now, record.ttl),
    });
    return Promise.resolve('deleted');
  }

  // --- ItemRepository ---

  findLatestAny(store: StoreName, key: ItemKey): Promise<LatestItemRecord | undefined> {
    return Promise.resolve(this.latest.get(itemId(store, key)));
  }

  commitChange(
    latest: LatestItemRecord,
    history: HistoryEntryRecord,
    expectedHash: ContentHash | null,
    now: Date,
  ): Promise<'committed' | 'conflict' | 'store-missing'> {
    const owner = this.stores.get(latest.store);
    if (owner === undefined || !isLive(owner, now)) {
      return Promise.resolve('store-missing');
    }
    const id = itemId(latest.store, latest.key);
    const current = this.latest.get(id);
    const currentLive = current !== undefined && isLive(current, now);
    const guardHolds =
      expectedHash === null ? !currentLive : currentLive && current.hash === expectedHash;
    if (!guardHolds) {
      return Promise.resolve('conflict');
    }
    this.latest.set(id, latest);
    const entries = this.history.get(id) ?? [];
    entries.push(history);
    entries.sort((a, b) => compareStrings(a.id, b.id));
    this.history.set(id, entries);
    return Promise.resolve('committed');
  }

  updateLatestMeta(
    store: StoreName,
    key: ItemKey,
    expectedHash: ContentHash,
    meta: JsonValue,
    now: Date,
  ): Promise<'updated' | 'conflict'> {
    const id = itemId(store, key);
    const current = this.latest.get(id);
    if (current === undefined || !isLive(current, now) || current.hash !== expectedHash) {
      return Promise.resolve('conflict');
    }
    this.latest.set(id, { ...current, meta });
    return Promise.resolve('updated');
  }

  listLatestLive(
    store: StoreName,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<LatestItemRecord>> {
    let afterKey: string | undefined;
    try {
      afterKey = cursor === undefined ? undefined : requireCursorField(cursor, 'k');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const live = [...this.latest.values()]
      .filter((record) => record.store === store && isLive(record, now))
      .filter((record) => afterKey === undefined || compareStrings(record.key, afterKey) > 0)
      .sort((a, b) => compareStrings(a.key, b.key));
    return Promise.resolve(paginate(live, limit, (record) => encodeCursor({ k: record.key })));
  }

  listHistoryLive(
    store: StoreName,
    key: ItemKey,
    now: Date,
    limit: number,
    cursor?: string,
  ): Promise<Page<HistoryEntryRecord>> {
    let beforeId: string | undefined;
    try {
      beforeId = cursor === undefined ? undefined : requireCursorField(cursor, 'i');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const live = (this.history.get(itemId(store, key)) ?? [])
      .filter((entry) => isLive(entry, now))
      .filter((entry) => beforeId === undefined || compareStrings(entry.id, beforeId) < 0)
      .sort((a, b) => compareStrings(b.id, a.id));
    return Promise.resolve(paginate(live, limit, (entry) => encodeCursor({ i: entry.id })));
  }

  softDeleteItem(store: StoreName, key: ItemKey, now: Date): Promise<'deleted' | 'not-found'> {
    const id = itemId(store, key);
    const current = this.latest.get(id);
    if (current === undefined || !isLive(current, now)) {
      return Promise.resolve('not-found');
    }
    this.markLatestDeleted(id, current, now);
    this.markHistoryDeleted(id, now);
    return Promise.resolve('deleted');
  }

  softDeleteStoreContents(store: StoreName, now: Date): Promise<void> {
    for (const [id, record] of this.latest) {
      if (record.store === store && isLive(record, now)) {
        this.markLatestDeleted(id, record, now);
      }
    }
    for (const [id, entries] of this.history) {
      if (entries[0]?.store === store) {
        this.markHistoryDeleted(id, now);
      }
    }
    return Promise.resolve();
  }

  /** Test-only view of the raw records, including soft-deleted ones. */
  snapshot(): {
    stores: StoreRecord[];
    latest: LatestItemRecord[];
    history: HistoryEntryRecord[];
  } {
    return {
      stores: [...this.stores.values()],
      latest: [...this.latest.values()],
      history: [...this.history.values()].flat(),
    };
  }

  private markLatestDeleted(id: string, record: LatestItemRecord, now: Date): void {
    this.latest.set(id, {
      ...record,
      deletedAt: now.toISOString(),
      ttl: cappedDeletionTtl(now, record.ttl),
    });
  }

  private markHistoryDeleted(id: string, now: Date): void {
    const entries = this.history.get(id) ?? [];
    this.history.set(
      id,
      entries.map((entry) =>
        isLive(entry, now)
          ? { ...entry, deletedAt: now.toISOString(), ttl: cappedDeletionTtl(now, entry.ttl) }
          : entry,
      ),
    );
  }
}
