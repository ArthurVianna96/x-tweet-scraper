/**
 * Narrowing helpers for X's GraphQL payloads.
 *
 * These responses are wide, deeply nested, and change without notice — X has already
 * moved `followers_count` out of `legacy` since most published scrapers were written.
 * So they are not validated against a schema: a schema would reject the whole payload
 * over one moved field. They are read defensively by path, and anything missing becomes
 * `null` (SPEC.md §3.2). `unknown` in, narrowed value out, never `any`.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Coerces numeric strings. `views.count` arrives as a string (`"1234"`) while every
 * other metric is a number; emitting one string column in an otherwise numeric output
 * would break naive consumers (SPEC.md §3.2).
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Walks a path, returning `undefined` the moment anything is missing or not an object. */
export function path(value: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (record === null) return undefined;
    current = record[key];
  }
  return current;
}

export function typenameOf(value: unknown): string | null {
  return asString(path(value, '__typename'));
}
