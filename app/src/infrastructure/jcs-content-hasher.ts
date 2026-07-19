import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';

import type { CanonicalHash, ContentHasher } from '../application/ports/content-hasher.js';
import { asContentHash } from '../domain/content-hash.js';
import type { JsonValue } from '../domain/json.js';

/** RFC 8785 (JCS) canonical JSON + SHA-256 (see plan section 05a). */
export class JcsContentHasher implements ContentHasher {
  hash(value: JsonValue): CanonicalHash {
    const canonical = canonicalize(value);
    if (canonical === undefined) {
      throw new Error('Canonicalization produced no output for a JSON value');
    }
    const bytes = Buffer.from(canonical, 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { hash: asContentHash(digest), canonicalByteLength: bytes.byteLength };
  }
}
