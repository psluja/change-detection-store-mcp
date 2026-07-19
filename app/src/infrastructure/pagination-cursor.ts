import type { Page } from '../application/ports/item-repository.js';
import { InvalidCursorError } from '../domain/errors.js';

/**
 * Opaque cursor format shared by all storage adapters, so the port contract
 * (and its tests) cannot diverge between implementations.
 */
export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((entry) => typeof entry === 'string')
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the error below
  }
  throw new InvalidCursorError();
}

/** Decodes the cursor and requires the given field, so a cursor from a
 * different operation (or garbage) fails loudly instead of resetting paging. */
export function requireCursorField(cursor: string, field: string): string {
  const value = decodeCursor(cursor)[field];
  if (value === undefined) {
    throw new InvalidCursorError();
  }
  return value;
}

/**
 * Builds a page from up-to-(limit+1) collected records: the extra record only
 * proves more data exists and turns into `nextCursor` of the last returned one.
 */
export function paginate<T>(records: T[], limit: number, cursorOf: (record: T) => string): Page<T> {
  const page = records.slice(0, limit);
  if (records.length <= limit) {
    return { items: page };
  }
  const last = page[page.length - 1];
  return last === undefined ? { items: page } : { items: page, nextCursor: cursorOf(last) };
}
