/** SHA-256 hex digest of the RFC 8785 canonical form of an item value. */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Guards the internal invariant that stored hashes are SHA-256 hex digests.
 * A violation means corrupt storage or a programming error, not client fault,
 * hence a plain Error instead of a DomainError.
 */
export function asContentHash(raw: string): ContentHash {
  if (!CONTENT_HASH_PATTERN.test(raw)) {
    throw new Error('Not a SHA-256 hex digest');
  }
  return raw as ContentHash;
}
