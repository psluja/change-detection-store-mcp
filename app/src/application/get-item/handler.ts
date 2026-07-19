import { StoreNotFoundError } from '../../domain/errors.js';
import { parseItemKey } from '../../domain/item-key.js';
import { isLive } from '../../domain/retention.js';
import { parseStoreName } from '../../domain/store-name.js';
import type { Clock } from '../ports/clock.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { GetItemCommand, GetItemResult } from './command.js';

export class GetItemHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: GetItemCommand): Promise<GetItemResult> {
    const store = parseStoreName(command.store);
    const key = parseItemKey(command.key);
    const now = this.clock.now();
    if ((await this.stores.findLive(store, now)) === undefined) {
      throw new StoreNotFoundError(store);
    }

    const latest = await this.items.findLatestAny(store, key);
    if (latest === undefined || !isLive(latest, now)) {
      return { found: false };
    }
    return {
      found: true,
      value: latest.value,
      hash: latest.hash,
      date: latest.date,
      ...(latest.meta !== undefined ? { meta: latest.meta } : {}),
    };
  }
}
