import { InvalidStoreNameError } from './errors.js';

/**
 * The `#` composite-key separator is deliberately outside this alphabet;
 * widening the pattern would open PK/SK injection (see plan section 05).
 */
export const STORE_NAME_PATTERN = /^[a-z0-9_-]{3,12}$/;

/** Validated store name (lowercase alphanumerics, `-`, `_`; 3-12 chars). */
export type StoreName = string & { readonly __brand: 'StoreName' };

export function parseStoreName(raw: string): StoreName {
  if (!STORE_NAME_PATTERN.test(raw)) {
    throw new InvalidStoreNameError(raw);
  }
  return raw as StoreName;
}
