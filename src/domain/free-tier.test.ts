import { describe, expect, it, vi } from 'vitest';

import { collect } from './collect.js';
import {
  FREE_TIER_CAP,
  FREE_TIER_REQUESTS_PER_RESULT,
  effectiveCap,
  requestBudgetFor,
  resolveEntitlement,
} from './entitlement.js';
import { ResultSink, resumePushCount } from './result-sink.js';

/**
 * The suite the brief requires (§7): "a free user requesting 1000 results still gets 10."
 *
 * Everything here is offline and platform-free. The only seam is constructor injection
 * (SPEC.md §8) — no module mocking, no Apify, no network.
 */

interface Item {
  readonly id: string;
}

/** A dataset stand-in: what `Actor.pushData` would have written. */
function fakeDataset() {
  const items: Item[] = [];
  return { items, push: async (item: Item) => void items.push(item) };
}

/**
 * A lazy paged source, shaped like the real crawl: it fetches a page only when pulled,
 * and records every page fetch so a test can prove the crawl actually stopped.
 */
function pagedSource(opts: { pages: number; pageSize: number }) {
  const pagesFetched: number[] = [];
  let closed = false;

  async function* generate(): AsyncGenerator<Item> {
    try {
      for (let page = 0; page < opts.pages; page++) {
        pagesFetched.push(page);
        for (let i = 0; i < opts.pageSize; i++) {
          yield { id: `${page}-${i}` };
        }
      }
    } finally {
      closed = true;
    }
  }

  return { generate, pagesFetched, isClosed: () => closed };
}

const acceptAll = () => true;
const keyOf = (item: Item) => item.id;

describe('free-tier cap (brief §6, §7 — required)', () => {
  it('gives a free user exactly 10 items when they ask for 1000', async () => {
    const entitlement = await resolveEntitlement(async () => ({ paid: false }));
    const dataset = fakeDataset();
    const source = pagedSource({ pages: 100, pageSize: 20 });

    const sink = new ResultSink<Item>({
      cap: effectiveCap(entitlement, 1000),
      push: dataset.push,
    });
    const stats = await collect(source.generate(), { sink, matches: acceptAll, keyOf });

    expect(dataset.items).toHaveLength(FREE_TIER_CAP);
    expect(stats.pushed).toBe(10);
    expect(stats.stoppedAtCap).toBe(true);
  });

  it('gives a paid user all 1000', async () => {
    const entitlement = await resolveEntitlement(async () => ({ paid: true }));
    const dataset = fakeDataset();
    const source = pagedSource({ pages: 100, pageSize: 20 });

    const sink = new ResultSink<Item>({
      cap: effectiveCap(entitlement, 1000),
      push: dataset.push,
    });
    await collect(source.generate(), { sink, matches: acceptAll, keyOf });

    expect(entitlement.paid).toBe(true);
    expect(entitlement.cap).toBeNull();
    expect(dataset.items).toHaveLength(1000);
  });

  it('stops the crawl, not just the output — one page fetched, generator closed', async () => {
    const dataset = fakeDataset();
    // 20 tweets per page is the measured `UserTweets` page size (SPEC.md §6).
    const source = pagedSource({ pages: 100, pageSize: 20 });

    const sink = new ResultSink<Item>({ cap: FREE_TIER_CAP, push: dataset.push });
    await collect(source.generate(), { sink, matches: acceptAll, keyOf });

    // This is the assertion that separates a real gate from a display filter: a free
    // user asking for 1000 results costs us one request, not fifty.
    expect(source.pagesFetched).toEqual([0]);
    expect(source.isClosed()).toBe(true);
  });

  it('reports false from push() at the cap, and refuses everything after', async () => {
    const dataset = fakeDataset();
    const sink = new ResultSink<Item>({ cap: 3, push: dataset.push });

    expect(await sink.push({ id: 'a' })).toBe(true);
    expect(await sink.push({ id: 'b' })).toBe(true);
    // The item that fills the cap is accepted, and the caller is told to stop.
    expect(await sink.push({ id: 'c' })).toBe(false);
    // Anything after is refused outright.
    expect(await sink.push({ id: 'd' })).toBe(false);

    expect(dataset.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(sink.capacityReached).toBe(true);
  });

  it('does not overshoot when parallel account chains push concurrently', async () => {
    // SPEC.md §4.3: the check-then-increment must not straddle an await. This test fails
    // if `this.pushed++` is moved below `await this.opts.push(item)`.
    const dataset = fakeDataset();
    const slowPush = async (item: Item) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      dataset.items.push(item);
    };
    const sink = new ResultSink<Item>({ cap: FREE_TIER_CAP, push: slowPush });

    await Promise.all(Array.from({ length: 50 }, (_, i) => sink.push({ id: `p${i}` })));

    expect(dataset.items).toHaveLength(FREE_TIER_CAP);
    expect(sink.count).toBe(FREE_TIER_CAP);
  });
});

describe('an unverified run is bounded on cost as well as on results (SPEC.md §4.3)', () => {
  it('lowers the request budget in proportion to what the run may return', async () => {
    // The push cap stops at N *matches*. A low-selectivity search never reaches N, so the
    // cap never engages: measured, a free keyword run spent 328 requests and 10 guest
    // tokens fetching 7,287 tweets to deliver 9 results.
    const free = await resolveEntitlement(async () => ({ paid: false }));

    expect(requestBudgetFor(free, 500)).toBe(FREE_TIER_CAP * FREE_TIER_REQUESTS_PER_RESULT);
    expect(requestBudgetFor(free, 500)).toBeLessThan(500);
  });

  it('never raises a budget the caller set lower', async () => {
    const free = await resolveEntitlement(async () => ({ paid: false }));
    expect(requestBudgetFor(free, 20)).toBe(20);
  });

  it('leaves a paid run\u2019s configured budget alone', async () => {
    const paid = await resolveEntitlement(async () => ({ paid: true }));
    expect(requestBudgetFor(paid, 500)).toBe(500);
    expect(requestBudgetFor(paid, 100_000)).toBe(100_000);
  });

  it('bounds a run that cannot be verified, exactly like a free one', async () => {
    const unverified = await resolveEntitlement(async () => {
      throw new Error('store unreachable');
    });
    expect(requestBudgetFor(unverified, 500)).toBe(FREE_TIER_CAP * FREE_TIER_REQUESTS_PER_RESULT);
  });
});

describe('free-tier cap survives resume (SPEC.md §4.5)', () => {
  it('pushes 0 more after a migration that already delivered the cap', async () => {
    const dataset = fakeDataset();

    // Incarnation 1: normal run, hits the cap, migrates.
    const first = new ResultSink<Item>({ cap: FREE_TIER_CAP, push: dataset.push });
    await collect(pagedSource({ pages: 10, pageSize: 20 }).generate(), {
      seen: new Set(),
      sink: first,
      matches: acceptAll,
      keyOf,
    });
    const persisted = first.count;

    // Incarnation 2: resumes with the persisted counter and the dataset's own count.
    const second = new ResultSink<Item>({
      cap: FREE_TIER_CAP,
      push: dataset.push,
      alreadyPushed: resumePushCount(persisted, dataset.items.length),
    });
    const source = pagedSource({ pages: 10, pageSize: 20 });
    const stats = await collect(source.generate(), { sink: second, matches: acceptAll, keyOf });

    expect(stats.pushed).toBe(0);
    expect(dataset.items).toHaveLength(FREE_TIER_CAP);
    // Nothing was even fetched — a resumed capped run costs zero requests.
    expect(source.pagesFetched).toEqual([]);
  });

  it('defeats the resurrect-and-reset bypass: a tampered counter is floored on itemCount', async () => {
    const dataset = fakeDataset();
    for (let i = 0; i < FREE_TIER_CAP; i++) dataset.items.push({ id: `seed${i}` });

    // The attack: the runner owns the run's key-value store, so they overwrite the
    // persisted counter with 0 and resurrect the run.
    const tampered = 0;

    const sink = new ResultSink<Item>({
      cap: FREE_TIER_CAP,
      push: dataset.push,
      alreadyPushed: resumePushCount(tampered, dataset.items.length),
    });
    const stats = await collect(pagedSource({ pages: 10, pageSize: 20 }).generate(), {
      sink,
      matches: acceptAll,
      keyOf,
    });

    expect(stats.pushed).toBe(0);
    expect(dataset.items).toHaveLength(FREE_TIER_CAP);
  });

  it('floors on whichever authority is higher', () => {
    expect(resumePushCount(10, 0)).toBe(10); // dataset wiped, counter remembers
    expect(resumePushCount(0, 10)).toBe(10); // counter tampered, dataset remembers
    expect(resumePushCount(null, 7)).toBe(7); // first resume, nothing persisted yet
    expect(resumePushCount(undefined, 0)).toBe(0);
  });
});

describe('entitlement resolution fails closed (SPEC.md §4.4)', () => {
  const cases: ReadonlyArray<[string, () => Promise<unknown>, string]> = [
    [
      'lookup throws',
      async () => {
        throw new Error('kv timeout');
      },
      'entitlement_unavailable',
    ],
    ['lookup returns undefined', async () => undefined, 'free_tier'],
    ['lookup returns null', async () => null, 'free_tier'],
    ['record says paid: false', async () => ({ paid: false }), 'free_tier'],
    ['record is malformed', async () => ({ plan: 'gold' }), 'entitlement_unavailable'],
    ['paid is the string "true"', async () => ({ paid: 'true' }), 'entitlement_unavailable'],
    ['record is a bare string', async () => 'paid', 'entitlement_unavailable'],
  ];

  it.each(cases)('%s → free', async (_name, fetchRecord, reason) => {
    const entitlement = await resolveEntitlement(fetchRecord);

    expect(entitlement.paid).toBe(false);
    expect(entitlement.limited).toBe(true);
    expect(entitlement.cap).toBe(FREE_TIER_CAP);
    expect(entitlement.reason).toBe(reason);
    expect(effectiveCap(entitlement, 1000)).toBe(FREE_TIER_CAP);
  });

  it('grants paid only on a literal `paid: true`', async () => {
    const entitlement = await resolveEntitlement(async () => ({ paid: true, plan: 'gold' }));

    expect(entitlement.paid).toBe(true);
    expect(entitlement.limited).toBe(false);
    expect(entitlement.reason).toBeNull();
    expect(effectiveCap(entitlement, 1000)).toBe(1000);
  });

  it('separates "verified free" from "could not verify" for alerting (§4.6)', async () => {
    const verified = await resolveEntitlement(async () => ({ paid: false }));
    const unverified = await resolveEntitlement(async () => {
      throw new Error('502 from key-value store');
    });

    // Same cap, different meaning: the second one may be capping a paying customer.
    expect(verified.cap).toBe(unverified.cap);
    expect(verified.reason).toBe('free_tier');
    expect(unverified.reason).toBe('entitlement_unavailable');
    expect(unverified.detail).toContain('502');
  });

  it('never lowers a paid user below their own maxResults', async () => {
    const entitlement = await resolveEntitlement(async () => ({ paid: true }));
    expect(effectiveCap(entitlement, 5)).toBe(5);
    expect(effectiveCap(entitlement, 100_000)).toBe(100_000);
  });
});

describe('collect()', () => {
  it('counts filtered and duplicate items without spending cap on them', async () => {
    const dataset = fakeDataset();
    const sink = new ResultSink<Item>({ cap: 100, push: dataset.push });

    async function* source(): AsyncGenerator<Item> {
      yield { id: 'a' };
      yield { id: 'a' }; // duplicate
      yield { id: 'skip-me' };
      yield { id: 'b' };
    }

    const stats = await collect(source(), {
      sink,
      matches: (item) => !item.id.startsWith('skip'),
      keyOf,
    });

    expect(stats).toEqual({
      fetched: 4,
      filteredOut: 1,
      duplicatesDropped: 1,
      pushed: 2,
      stoppedAtCap: false,
    });
  });

  it('carries a restored seen-set across a migration', async () => {
    const dataset = fakeDataset();
    const sink = new ResultSink<Item>({ cap: 100, push: dataset.push });
    const seen = new Set(['a', 'b']);

    async function* source(): AsyncGenerator<Item> {
      yield { id: 'a' };
      yield { id: 'b' };
      yield { id: 'c' };
    }

    const stats = await collect(source(), { sink, matches: acceptAll, keyOf, seen });

    expect(stats.duplicatesDropped).toBe(2);
    expect(dataset.items.map((i) => i.id)).toEqual(['c']);
  });

  it('never pulls the source when the cap is already spent', async () => {
    const pull = vi.fn();
    async function* source(): AsyncGenerator<Item> {
      pull();
      yield { id: 'a' };
    }

    const sink = new ResultSink<Item>({
      cap: FREE_TIER_CAP,
      push: async () => {},
      alreadyPushed: FREE_TIER_CAP,
    });
    const stats = await collect(source(), { sink, matches: acceptAll, keyOf });

    expect(pull).not.toHaveBeenCalled();
    expect(stats.stoppedAtCap).toBe(true);
  });
});
