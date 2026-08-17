/**
 * Merge N async sources, pulling at most `concurrency` of them at a time.
 *
 * This is the parallelism model from SPEC.md §6: a cursor chain is inherently
 * sequential — page 2 needs page 1's cursor — so the only place to parallelise is
 * *across accounts*. Each account is one lazy chain; this merges them.
 *
 * Two properties matter and both are tested:
 *
 * 1. **Lazy.** Nothing is fetched until the consumer pulls. That is what lets the
 *    free-tier cap stop the crawl rather than merely truncate the output (§4.3).
 * 2. **Unwinds.** When the consumer `break`s, every in-flight source is returned, so no
 *    orphan chain keeps paging in the background and spending the request budget on
 *    results nobody will read.
 */
export async function* mergeConcurrent<T>(
  sources: Iterable<() => AsyncIterator<T>>,
  concurrency: number,
): AsyncGenerator<T> {
  const queue = [...sources];
  const active = new Map<number, { iterator: AsyncIterator<T>; pending: Promise<Slot<T>> }>();
  let nextKey = 0;

  const start = (factory: () => AsyncIterator<T>): void => {
    const key = nextKey++;
    const iterator = factory();
    active.set(key, { iterator, pending: advance(key, iterator) });
  };

  try {
    while (active.size < Math.max(1, concurrency) && queue.length > 0) {
      start(queue.shift()!);
    }

    while (active.size > 0) {
      // Race the outstanding pulls: whichever account answers first is emitted first,
      // so one slow account cannot stall the others.
      const slot = await Promise.race([...active.values()].map((entry) => entry.pending));
      const entry = active.get(slot.key);
      if (entry === undefined) continue;

      if (slot.done) {
        active.delete(slot.key);
        if (queue.length > 0) start(queue.shift()!);
        continue;
      }

      entry.pending = advance(slot.key, entry.iterator);
      yield slot.value as T;
    }
  } finally {
    // Reached on `break`, `return` and `throw` alike. Without this, breaking out of the
    // consumer loop at the cap would leave the remaining chains mid-flight.
    await Promise.allSettled(
      [...active.values()].map((entry) => entry.iterator.return?.(undefined)),
    );
  }
}

interface Slot<T> {
  readonly key: number;
  readonly done: boolean;
  readonly value?: T;
}

async function advance<T>(key: number, iterator: AsyncIterator<T>): Promise<Slot<T>> {
  const result = await iterator.next();
  return result.done === true ? { key, done: true } : { key, done: false, value: result.value };
}
