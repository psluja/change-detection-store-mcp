import type { JsonValue } from '../../domain/json.js';

export interface PatchItemsEntry {
  readonly key: string;
  readonly value: JsonValue;
  /** Optional sidecar JSON outside change detection — see PatchItemCommand.meta. */
  readonly meta?: JsonValue | undefined;
}

export interface PatchItemsCommand {
  readonly store: string;
  readonly items: readonly PatchItemsEntry[];
}

/** Per-key outcome, in input order: a change-detection result or a typed error. */
export type PatchItemsResultEntry =
  | {
      readonly key: string;
      readonly changed: boolean;
      readonly hash: string;
      readonly date: string;
    }
  | { readonly key: string; readonly error: string };

export interface PatchItemsResult {
  readonly results: readonly PatchItemsResultEntry[];
}
