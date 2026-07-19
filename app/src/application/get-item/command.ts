import type { JsonValue } from '../../domain/json.js';

export interface GetItemCommand {
  readonly store: string;
  readonly key: string;
}

/**
 * A missing key is a normal state (first run, nothing stored yet), not an
 * error — hence `found` instead of an exception.
 */
export type GetItemResult =
  | {
      readonly found: true;
      readonly value: JsonValue;
      readonly hash: string;
      readonly date: string;
      /** Sidecar JSON from the most recent patch that carried one. */
      readonly meta?: JsonValue;
    }
  | { readonly found: false };
