/**
 * Snowflake ids encode their creation time, so `since`/`until` become an id range and
 * `sortBy: latest` is a descending id sort — ids are monotonic, so id order is time order.
 */

/** X's epoch: 2010-11-04T01:42:54.657Z. */
export const TWITTER_EPOCH_MS = 1288834974657;

const TIMESTAMP_SHIFT = 22n;

export function snowflakeToMs(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  return Number(BigInt(id) >> TIMESTAMP_SHIFT) + TWITTER_EPOCH_MS;
}

/** The smallest id that could have been minted at `ms`. */
export function snowflakeAtMs(ms: number): bigint {
  const offset = BigInt(Math.max(0, Math.floor(ms) - TWITTER_EPOCH_MS));
  return offset << TIMESTAMP_SHIFT;
}

/** BigInt because these overflow `number`. */
export function compareIdDesc(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

/**
 * Both bounds are inclusive. A date without a time is a whole day, so `until` runs to
 * 23:59:59.999 — treating it as midnight would silently drop a day.
 */
export function parseBoundary(value: string, edge: 'since' | 'until'): number | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return null;

  const ms = parsed.getTime();
  if (edge === 'until' && dateOnly) return ms + 24 * 60 * 60 * 1000 - 1;
  return ms;
}
