export interface DeleteStoreCommand {
  readonly name: string;
}

export interface DeleteStoreResult {
  readonly name: string;
  readonly deletedAt: string;
}
