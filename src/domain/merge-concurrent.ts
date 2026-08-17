/**
 * Merge N async sources, pulling at most `concurrency` at a time. A cursor chain is
 * sequential — page 2 needs page 1's cursor — so accounts are the only axis to
 * parallelise on.
 *
 * Lazy, and unwinds: when the consumer breaks, every in-flight source is returned so no
 * orphan chain keeps paging in the background.
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
