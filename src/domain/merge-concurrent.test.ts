import { describe, expect, it } from 'vitest';

import { mergeConcurrent } from './merge-concurrent.js';

function trackedSource(label: string, count: number, log: string[]) {
  return () => {
    let closed = false;
    const iterator: AsyncIterator<string> = {
      async next() {
        if (closed) return { done: true, value: undefined };
        log.push(`${label}:pull`);
        if (count === 0) return { done: true, value: undefined };
        count--;
        return { done: false, value: `${label}-${count}` };
      },
      async return() {
        log.push(`${label}:closed`);
        closed = true;
        return { done: true, value: undefined };
      },
    };
    return iterator;
  };
}

describe('mergeConcurrent', () => {
  it('emits everything from every source', async () => {
    const log: string[] = [];
    const merged = mergeConcurrent(
      [trackedSource('a', 3, log), trackedSource('b', 2, log), trackedSource('c', 1, log)],
      2,
    );

    const seen: string[] = [];
    for await (const value of merged) seen.push(value);

    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((v) => v[0]))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('starts at most `concurrency` sources before any are exhausted', async () => {
    const log: string[] = [];
    const merged = mergeConcurrent(
      [trackedSource('a', 5, log), trackedSource('b', 5, log), trackedSource('c', 5, log)],
      2,
    );

    const iterator = merged[Symbol.asyncIterator]();
    await iterator.next();

    // The third account has not been touched: the request budget is spent two chains at
    // a time, not all at once.
    expect(log.some((entry) => entry.startsWith('c:'))).toBe(false);
    await iterator.return?.(undefined);
  });

  it('closes every in-flight source when the consumer breaks', async () => {
    const log: string[] = [];
    const merged = mergeConcurrent([trackedSource('a', 100, log), trackedSource('b', 100, log)], 2);

    // This is the free-tier cap path: the consumer stops early and the crawl must stop
    // with it, rather than leaving chains paging in the background.
    for await (const _value of merged) break;

    expect(log).toContain('a:closed');
    expect(log).toContain('b:closed');
  });

  it('is lazy — an unconsumed merge pulls nothing', async () => {
    const log: string[] = [];
    mergeConcurrent([trackedSource('a', 5, log)], 2);

    expect(log).toEqual([]);
  });

  it('handles an empty source list', async () => {
    const seen: string[] = [];
    for await (const value of mergeConcurrent<string>([], 4)) seen.push(value);
    expect(seen).toEqual([]);
  });
});
