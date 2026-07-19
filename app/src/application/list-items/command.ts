export interface ListItemsCommand {
  readonly store: string;
  readonly cursor?: string | undefined;
}

export interface ItemMetaSummary {
  readonly key: string;
  readonly date: string;
  readonly hash: string;
}

export interface ListItemsResult {
  readonly items: readonly ItemMetaSummary[];
  readonly nextCursor?: string;
}
