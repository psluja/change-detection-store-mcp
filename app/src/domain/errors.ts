/** Base class for all domain errors; `code` is a stable machine-readable identifier. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
}

const MAX_ECHOED_INPUT_LENGTH = 64;

/** Truncates and quotes raw client input before echoing it back in an error message. */
function echo(raw: string): string {
  const truncated =
    raw.length > MAX_ECHOED_INPUT_LENGTH ? `${raw.slice(0, MAX_ECHOED_INPUT_LENGTH)}…` : raw;
  return JSON.stringify(truncated);
}

export class InvalidStoreNameError extends DomainError {
  readonly code = 'INVALID_STORE_NAME';
  constructor(raw: string) {
    super(`Invalid store name ${echo(raw)}: expected 3-12 chars matching ^[a-z0-9_-]+$`);
  }
}

export class InvalidItemKeyError extends DomainError {
  readonly code = 'INVALID_ITEM_KEY';
  constructor(raw: string) {
    super(`Invalid item key ${echo(raw)}: expected 3-32 chars matching ^[a-zA-Z0-9_|-]+$`);
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Invalid pagination cursor');
  }
}

export class ValueTooLargeError extends DomainError {
  readonly code = 'VALUE_TOO_LARGE';
  constructor(actualBytes: number, maxBytes: number, field: 'value' | 'meta' = 'value') {
    super(
      field === 'value'
        ? `Value is ${String(actualBytes)} bytes after canonicalization; the maximum is ${String(maxBytes)} bytes`
        : `Meta is ${String(actualBytes)} bytes serialized; the maximum is ${String(maxBytes)} bytes`,
    );
  }
}

export class StoreNotFoundError extends DomainError {
  readonly code = 'STORE_NOT_FOUND';
  constructor(name: string) {
    super(`Store ${echo(name)} does not exist`);
  }
}

export class ItemNotFoundError extends DomainError {
  readonly code = 'ITEM_NOT_FOUND';
  constructor(store: string, key: string) {
    super(`Item ${echo(key)} does not exist in store ${echo(store)}`);
  }
}

export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
  constructor(store: string, key?: string) {
    super(
      key === undefined
        ? `Store ${echo(store)} was modified concurrently; retry the operation`
        : `Item ${echo(key)} in store ${echo(store)} was modified concurrently; retry the operation`,
    );
  }
}
