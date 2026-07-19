import type { JsonValue } from '../../domain/json.js';

export interface PatchItemCommand {
  readonly store: string;
  readonly key: string;
  readonly value: JsonValue;
  /**
   * Optional sidecar JSON OUTSIDE change detection: persisted on every call
   * (even when the value is unchanged), never hashed, replaced whole.
   */
  readonly meta?: JsonValue | undefined;
}

export interface PatchItemResult {
  /** True when the value's hash differed and a new record was written. */
  readonly changed: boolean;
  readonly hash: string;
  readonly date: string;
}
