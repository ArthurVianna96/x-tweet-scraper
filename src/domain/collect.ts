import type { ResultSink } from './result-sink.js';

/**
 * `source` must be lazy. `break` unwinds the generator chain and stops cursor paging,
 * which is what makes the cap a cost control rather than a display filter.
 */
export interface CollectOptions<T> {
  readonly sink: ResultSink<T>;
  readonly matches: (item: T) => boolean;
  readonly keyOf: (item: T) => string;
  /** Keys already emitted by an earlier incarnation of this run. */
  readonly seen?: Set<string>;
}

export interface CollectStats {
  readonly fetched: number;
  readonly filteredOut: number;
  readonly duplicatesDropped: number;
  readonly pushed: number;
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
