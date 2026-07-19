import { StoreNotFoundError } from '../../domain/errors.js';
import { parseStoreName } from '../../domain/store-name.js';
import { LIST_ITEMS_PAGE_SIZE } from '../paging.js';
import type { Clock } from '../ports/clock.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { ListItemsCommand, ListItemsResult } from './command.js';

export class ListItemsHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: ListItemsCommand): Promise<ListItemsResult> {
    const store = parseStoreName(command.store);
    const now = this.clock.now();
    if ((await this.stores.findLive(store, now)) === undefined) {
      throw new StoreNotFoundError(store);
    }

    const page = await this.items.listLatestLive(store, now, LIST_ITEMS_PAGE_SIZE, command.cursor);
    const items = page.items.map((record) => ({
      key: record.key,
      date: record.date,
      hash: record.hash,
    }));
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
  }
}
