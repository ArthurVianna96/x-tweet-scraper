import type { ResultSink } from './result-sink.js';

/**
 * The consumer loop (SPEC.md §4.3). Pure, and deliberately the only place that decides
 * when to stop.
 *
 * `source` is expected to be **lazy** — a generator that fetches the next page only when
 * pulled. That is what turns the cap into a cost control rather than a display filter:
 * `break` ends the loop, which calls `.return()` on the iterator, which unwinds the
 * whole generator chain and stops cursor paging mid-crawl.
 */
export interface CollectOptions<T> {
  readonly sink: ResultSink<T>;
  /** Filter predicate (SPEC.md §3.1). Unspecified filters must accept everything. */
  readonly matches: (item: T) => boolean;
  /** Identity for deduplication — tweet id. Nested retweets and snowball overlap both
   *  produce genuine repeats, so this is required, not a bonus (brief §11). */
  readonly keyOf: (item: T) => string;
  /** Keys already emitted by a previous incarnation of this run (SPEC.md §5.3). */
  readonly seen?: Set<string>;
}

export interface CollectStats {
  /** Items pulled off the source, before any filtering. */
  readonly fetched: number;
  readonly filteredOut: number;
  readonly duplicatesDropped: number;
  readonly pushed: number;
  /** True when we stopped because the cap was reached rather than because the source ran dry. */
  readonly stoppedAtCap: boolean;
}

export async function collect<T>(
  source: AsyncIterable<T>,
  opts: CollectOptions<T>,
): Promise<CollectStats> {
  const seen = opts.seen ?? new Set<string>();
  let fetched = 0;
  let filteredOut = 0;
  let duplicatesDropped = 0;
  let stoppedAtCap = false;
  const before = opts.sink.count;

  // A cap already reached on resume must not pull the source even once.
  if (opts.sink.capacityReached) {
    return { fetched: 0, filteredOut: 0, duplicatesDropped: 0, pushed: 0, stoppedAtCap: true };
  }

  for await (const item of source) {
    fetched++;

    const key = opts.keyOf(item);
    if (seen.has(key)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(key);

    if (!opts.matches(item)) {
      filteredOut++;
      continue;
    }

    if (!(await opts.sink.push(item))) {
      stoppedAtCap = true;
      break;
    }
  }

  return {
    fetched,
    filteredOut,
    duplicatesDropped,
    pushed: opts.sink.count - before,
    stoppedAtCap,
  };
}
