import { InvalidItemKeyError } from './errors.js';

/**
 * Store-name alphabet plus `A-Z` and `|` — external IDs are case-sensitive
 * (e.g. `source|ID6HfGma`), so keys must preserve case. The `#` composite-key
 * separator stays excluded by design.
 */
export const ITEM_KEY_PATTERN = /^[a-zA-Z0-9_|-]{3,32}$/;

/** Validated item key (case-sensitive alphanumerics, `-`, `_`, `|`; 3-32 chars). */
export type ItemKey = string & { readonly __brand: 'ItemKey' };

export function parseItemKey(raw: string): ItemKey {
  if (!ITEM_KEY_PATTERN.test(raw)) {
    throw new InvalidItemKeyError(raw);
  }
  return raw as ItemKey;
}
