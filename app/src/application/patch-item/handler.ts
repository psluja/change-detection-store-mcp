import {
  ConcurrentModificationError,
  StoreNotFoundError,
  ValueTooLargeError,
} from '../../domain/errors.js';
import { parseItemKey } from '../../domain/item-key.js';
import { MAX_VALUE_CANONICAL_BYTES } from '../../domain/limits.js';
import type { JsonValue } from '../../domain/json.js';
import type { HistoryEntryRecord, LatestItemRecord } from '../../domain/records.js';
import { historyTtl, isLive } from '../../domain/retention.js';
import { parseStoreName } from '../../domain/store-name.js';
import type { Clock } from '../ports/clock.js';
import type { ContentHasher } from '../ports/content-hasher.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { PatchItemCommand, PatchItemResult } from './command.js';

const MAX_COMMIT_ATTEMPTS = 3;

export class PatchItemHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly hasher: ContentHasher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: PatchItemCommand): Promise<PatchItemResult> {
    const store = parseStoreName(command.store);
    const key = parseItemKey(command.key);
    const meta = command.meta;
    const now = this.clock.now();
    if ((await this.stores.findLive(store, now)) === undefined) {
      throw new StoreNotFoundError(store);
    }

    const { hash, canonicalByteLength } = this.hasher.hash(command.value);
    if (canonicalByteLength > MAX_VALUE_CANONICAL_BYTES) {
      throw new ValueTooLargeError(canonicalByteLength, MAX_VALUE_CANONICAL_BYTES);
    }
    if (meta !== undefined) {
      const metaBytes = Buffer.byteLength(JSON.stringify(meta), 'utf8');
      if (metaBytes > MAX_VALUE_CANONICAL_BYTES) {
        throw new ValueTooLargeError(metaBytes, MAX_VALUE_CANONICAL_BYTES, 'meta');
      }
    }

    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const existing = await this.items.findLatestAny(store, key);
      const live = existing !== undefined && isLive(existing, now);

      if (live && existing.hash === hash) {
        // Unchanged value: no history, no date bump — but meta (when given)
        // is ALWAYS persisted; it lives outside change detection.
        if (meta === undefined) {
          return { changed: false, hash, date: existing.date };
        }
        const metaOutcome = await this.items.updateLatestMeta(store, key, hash, meta, now);
        if (metaOutcome === 'updated') {
          return { changed: false, hash, date: existing.date };
        }
        continue; // the value changed concurrently — re-read and retry
      }

      const date = now.toISOString();
      const metaAttributes: { meta?: JsonValue } = meta === undefined ? {} : { meta };
      const latest: LatestItemRecord = {
        store,
        key,
        hash,
        date,
        value: command.value,
        ...metaAttributes,
      };
      const history: HistoryEntryRecord = {
        store,
        key,
        id: this.ids.nextUlid(now),
        hash,
        date,
        value: command.value,
        ...metaAttributes,
        ttl: historyTtl(now),
      };
      const outcome = await this.items.commitChange(
        latest,
        history,
        live ? existing.hash : null,
        now,
      );
      if (outcome === 'committed') {
        return { changed: true, hash, date };
      }
      if (outcome === 'store-missing') {
        throw new StoreNotFoundError(store);
      }
    }
    throw new ConcurrentModificationError(store, key);
  }
}
