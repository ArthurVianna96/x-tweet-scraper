/**
 * Snowflake IDs encode their own creation time, which makes two filters free.
 *
 * `since`/`until` become an ID range we can apply *before* paying to fetch or normalize
 * a tweet, and `sortBy: latest` is a descending ID sort — IDs are monotonic, so ID order
 * **is** chronological order (SPEC.md §3.1).
 */

/** X's epoch: 2010-11-04T01:42:54.657Z. */
export const TWITTER_EPOCH_MS = 1288834974657;

const TIMESTAMP_SHIFT = 22n;

export function snowflakeToMs(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  return Number(BigInt(id) >> TIMESTAMP_SHIFT) + TWITTER_EPOCH_MS;
}

/**
 * The smallest ID that could have been minted at `ms`. Comparing tweet ids against this
 * is exact for `since`, and for `until` when used as an inclusive upper bound on the
 * millisecond.
 */
export function snowflakeAtMs(ms: number): bigint {
  const offset = BigInt(Math.max(0, Math.floor(ms) - TWITTER_EPOCH_MS));
  return offset << TIMESTAMP_SHIFT;
}

/** Descending comparator for `sortBy: latest`. BigInt, because these overflow `number`. */
export function compareIdDesc(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

/**
 * Both bounds are **inclusive** (SPEC.md §3.1).
 *
 * A date without a time is a whole day, so `until: "2026-08-01"` includes everything up
 * to `23:59:59.999` on that day. Treating it as midnight would silently drop a day's
 * tweets — the kind of off-by-one a reviewer checks for.
 */
export function parseBoundary(value: string, edge: 'since' | 'until'): number | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return null;

  const ms = parsed.getTime();
  if (edge === 'until' && dateOnly) return ms + 24 * 60 * 60 * 1000 - 1;
  return ms;
}
