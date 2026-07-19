import { StoreNotFoundError } from '../../domain/errors.js';
import { parseStoreName } from '../../domain/store-name.js';
import type { Clock } from '../ports/clock.js';
import type { ItemRepository } from '../ports/item-repository.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { DeleteStoreCommand, DeleteStoreResult } from './command.js';

export class DeleteStoreHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly items: ItemRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: DeleteStoreCommand): Promise<DeleteStoreResult> {
    const name = parseStoreName(command.name);
    const now = this.clock.now();
    const outcome = await this.stores.softDelete(name, now);
    if (outcome === 'not-found') {
      throw new StoreNotFoundError(name);
    }
    await this.items.softDeleteStoreContents(name, now);
    return { name, deletedAt: now.toISOString() };
  }
}
