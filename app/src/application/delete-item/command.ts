export interface DeleteItemCommand {
  readonly store: string;
  readonly key: string;
}

export interface DeleteItemResult {
  readonly store: string;
  readonly key: string;
  readonly deletedAt: string;
}
