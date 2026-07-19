export interface StoreSummary {
  readonly name: string;
  readonly createdAt: string;
}

export interface ListStoresResult {
  readonly stores: readonly StoreSummary[];
}
