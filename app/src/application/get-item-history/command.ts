import type { JsonValue } from '../../domain/json.js';

export interface GetItemHistoryCommand {
  readonly store: string;
  readonly key: string;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface HistoryEntrySummary {
  readonly date: string;
  readonly hash: string;
  readonly value: JsonValue;
  /** Sidecar JSON snapshot from the patch that recorded this change. */
  readonly meta?: JsonValue;
}

export interface GetItemHistoryResult {
  readonly entries: readonly HistoryEntrySummary[];
  readonly nextCursor?: string;
}
