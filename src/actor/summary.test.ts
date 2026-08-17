import { describe, expect, it } from 'vitest';

import { PRICING, buildRunSummary, estimateCost } from './summary.js';

const base = {
  requestedMaxResults: 1000,
  entitlement: {
    paid: false,
    limited: true,
    reason: 'free_tier' as const,
    cap: 10,
    detail: null,
  },
  collect: { fetched: 120, filteredOut: 108, duplicatesDropped: 2, pushed: 10, stoppedAtCap: true },
  crawl: {
    seedsResolved: 5,
    accountsCrawled: 3,
    pagesFetched: 6,
    discoveryRequests: 1,
    handlesDiscovered: 12,
    accountsSkipped: { protected: 1, suspended: 0, notFound: 2 },
    budgetExhausted: false,
    cursors: {},
  },
  client: {
    requests: 8,
    bytes: 1_000_000,
    errors: { '429': 0, '403': 1, '404': 0, '5xx': 1, timeout: 0, other: 0 },
  },
  transfer: { requests: 10, bytes: 2_000_000 },
  discoveryStrategy: 'seeded-topic',
  tokensConsumed: 2,
  wallClockMs: 30_000,
  memoryMbytes: 1024,
};

describe('buildRunSummary (SPEC.md §7)', () => {
  it('reports selectivity so the request budget can be reasoned about', () => {
    const summary = buildRunSummary(base);

    expect(summary.selectivity).toBeCloseTo(10 / 120, 4);
    expect(summary.filteredOut).toBe(108);
    expect(summary.fetched).toBe(120);
  });

  it('separates X requests from total outbound requests', () => {
    // The queryId bundle and the seed lookup are not X GraphQL calls, but they do cost
    // proxy traffic — conflating them would understate the second and overstate the first.
    const summary = buildRunSummary(base);

    expect(summary.xRequests).toBe(8);
    expect(summary.totalRequests).toBe(10);
    expect(summary.bytesTransferred).toBe(2_000_000);
  });

  it('carries the entitlement verdict verbatim, including why', () => {
    const summary = buildRunSummary(base);

    expect(summary.limited).toBe(true);
    expect(summary.reason).toBe('free_tier');
    expect(summary.cap).toBe(10);
    expect(summary.requested).toBe(1000);
  });

  it('reports zero selectivity rather than dividing by zero on an empty run', () => {
    const summary = buildRunSummary({
      ...base,
      collect: { fetched: 0, filteredOut: 0, duplicatesDropped: 0, pushed: 0, stoppedAtCap: false },
    });

    expect(summary.selectivity).toBe(0);
    expect(summary.estimatedCostPer1kResults).toEqual({ proxyGB: 0, computeUnits: 0, usd: 0 });
  });
});

describe('estimateCost', () => {
  it('extrapolates from measured bytes and wall clock', () => {
    const cost = estimateCost({
      bytes: 100_000_000,
      pushed: 100,
      wallClockMs: 360_000,
      memoryMbytes: 1024,
    });

    // 100 MB for 100 results → 1 GB per 1000.
    expect(cost.proxyGB).toBeCloseTo(1, 4);
    // 1 GB of memory for 0.1h × 10 → 1 compute unit per 1000 results.
    expect(cost.computeUnits).toBeCloseTo(1, 4);
    expect(cost.usd).toBeCloseTo(PRICING.usdPerResidentialProxyGB + PRICING.usdPerComputeUnit, 3);
  });

  it('falls back to 1 GB when the platform does not report memory', () => {
    const cost = estimateCost({ bytes: 0, pushed: 10, wallClockMs: 3_600_000, memoryMbytes: null });
    expect(cost.computeUnits).toBeCloseTo(100, 2);
  });
});
