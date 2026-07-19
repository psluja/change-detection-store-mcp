export interface CreateStoreCommand {
  readonly name: string;
}

export interface CreateStoreResult {
  readonly name: string;
  readonly createdAt: string;
  /** True when this call created (or reactivated) the store; false when it already existed. */
  readonly created: boolean;
}
