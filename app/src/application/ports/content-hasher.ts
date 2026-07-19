import type { ContentHash } from '../../domain/content-hash.js';
import type { JsonValue } from '../../domain/json.js';

export interface CanonicalHash {
  readonly hash: ContentHash;
  /** Byte length of the canonical UTF-8 form; used to enforce the value size limit. */
  readonly canonicalByteLength: number;
}

/** Hashes a JSON value over its RFC 8785 canonical form. */
export interface ContentHasher {
  hash(value: JsonValue): CanonicalHash;
}
