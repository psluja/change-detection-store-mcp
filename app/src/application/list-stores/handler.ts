import type { Clock } from '../ports/clock.js';
import type { StoreRepository } from '../ports/store-repository.js';
import type { ListStoresResult } from './command.js';

export class ListStoresHandler {
  constructor(
    private readonly stores: StoreRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ListStoresResult> {
    const records = await this.stores.listLive(this.clock.now());
    return {
      stores: records.map((record) => ({ name: record.name, createdAt: record.createdAt })),
    };
  }
}
