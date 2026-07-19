import { StoreNotFoundError } from '../../domain/errors.js';
import { parseItemKey } from '../../domain/item-key.js';
import { parseStoreName } from '../../domain/store-name.js';
import {
  HISTORY_DEFAULT_PAGE_SIZE,
  HISTORY_MAX_PAGE_SIZE,
  HISTORY_MIN_PAGE_SIZE,
} from '../paging.js';
import type { Clock } from '../ports/clock.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { GetItemHistoryCommand, GetItemHistoryResult } from './command.js';

/** Clamps the client-supplied limit into [1, 200]; non-integers are floored. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return HISTORY_DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(limit);
  return Math.min(Math.max(floored, HISTORY_MIN_PAGE_SIZE), HISTORY_MAX_PAGE_SIZE);
}

export class GetItemHistoryHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: GetItemHistoryCommand): Promise<GetItemHistoryResult> {
    const store = parseStoreName(command.store);
    const key = parseItemKey(command.key);
    const now = this.clock.now();
    if ((await this.stores.findLive(store, now)) === undefined) {
      throw new StoreNotFoundError(store);
    }

    const page = await this.items.listHistoryLive(
      store,
      key,
      now,
      clampLimit(command.limit),
      command.cursor,
    );
    const entries = page.items.map((record) => ({
      date: record.date,
      hash: record.hash,
      value: record.value,
      ...(record.meta !== undefined ? { meta: record.meta } : {}),
    }));
    return page.nextCursor === undefined ? { entries } : { entries, nextCursor: page.nextCursor };
  }
}
