import { DomainError, InvalidStoreNameError, StoreNotFoundError } from '../../domain/errors.js';
import type { PatchItemHandler } from '../patch-item/handler.js';
import type { PatchItemsCommand, PatchItemsResult, PatchItemsResultEntry } from './command.js';

/** Protocol-level bound (also enforced by the tool schema). */
export const PATCH_ITEMS_MAX_BATCH = 50;

/**
 * Batch variant of patch_item: a poll of dozens of items becomes one call
 * instead of dozens. Composes the single-item use case sequentially; one bad
 * item becomes a per-key error entry instead of failing the batch. Store-level
 * failures (missing store, invalid store name) fail the whole batch — they
 * would repeat identically for every item.
 */
export class PatchItemsHandler {
  constructor(private readonly patchItem: PatchItemHandler) {}

  async execute(command: PatchItemsCommand): Promise<PatchItemsResult> {
    const results: PatchItemsResultEntry[] = [];
    for (const item of command.items) {
      try {
        const outcome = await this.patchItem.execute({
          store: command.store,
          key: item.key,
          value: item.value,
          meta: item.meta,
        });
        results.push({ key: item.key, ...outcome });
      } catch (error) {
        if (error instanceof StoreNotFoundError || error instanceof InvalidStoreNameError) {
          throw error;
        }
        if (error instanceof DomainError) {
          results.push({ key: item.key, error: `${error.code}: ${error.message}` });
        } else {
          throw error;
        }
      }
    }
    return { results };
  }
}
