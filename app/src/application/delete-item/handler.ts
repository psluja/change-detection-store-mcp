import { ItemNotFoundError, StoreNotFoundError } from '../../domain/errors.js';
import { parseItemKey } from '../../domain/item-key.js';
import { parseStoreName } from '../../domain/store-name.js';
import type { Clock } from '../ports/clock.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { DeleteItemCommand, DeleteItemResult } from './command.js';

export class DeleteItemHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: DeleteItemCommand): Promise<DeleteItemResult> {
    const store = parseStoreName(command.store);
    const key = parseItemKey(command.key);
    const now = this.clock.now();
    if ((await this.stores.findLive(store, now)) === undefined) {
      throw new StoreNotFoundError(store);
    }

    const outcome = await this.items.softDeleteItem(store, key, now);
    if (outcome === 'not-found') {
      throw new ItemNotFoundError(store, key);
    }
    return { store, key, deletedAt: now.toISOString() };
  }
}
