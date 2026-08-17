/**
 * X's payloads are wide, deeply nested, and change without notice, so they are read by
 * path rather than validated — a schema would reject a whole payload over one moved
 * field. Anything missing becomes `null`. `unknown` in, narrowed value out, never `any`.
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

/** Coerces numeric strings: `views.count` arrives as one while its siblings are numbers. */
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

/** `undefined` the moment anything on the path is missing or not an object. */
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
