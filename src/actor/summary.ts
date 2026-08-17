import type { CollectStats } from '../domain/collect.js';
import type { Entitlement } from '../domain/entitlement.js';
import type { TransferStats } from '../adapters/http/counting.js';
import type { CrawlStats } from '../adapters/x/crawl.js';
import type { HydrateStats } from '../adapters/x/hydrate.js';
import type { XClientStats } from '../adapters/x/graphql.js';

/**
 * Written to `OUTPUT` and logged. Reports the inputs to every performance claim —
 * requests, pages, bytes, selectivity, tokens, errors — so the numbers can be re-derived.
 */

export interface RunSummary {
  readonly requested: number;
  readonly fetched: number;
  readonly pushed: number;
  /** The ceiling actually applied, which is lowered for unverified runs. */
  readonly requestBudget: number;

  readonly limited: boolean;
  readonly reason: string | null;
  readonly cap: number | null;

  /** Ids asked for, hydrated, and not found. */
  readonly hydratedById: HydrateStats;

  readonly discoveryStrategy: string;
  readonly discoveryRequests: number;
  readonly seedsResolved: number;
  readonly accountsCrawled: number;
  readonly handlesDiscovered: number;
  readonly pagesFetched: number;

  readonly filteredOut: number;
  readonly selectivity: number;
  readonly duplicatesDropped: number;

  readonly accountsSkipped: CrawlStats['accountsSkipped'];
  /** Stopped on the request budget rather than on results or exhaustion. */
  readonly budgetExhausted: boolean;
  readonly tokensConsumed: number;
  /** GraphQL calls to X. */
  readonly xRequests: number;
  /** Every outbound request, including the queryId bundle and the seed lookup. */
  readonly totalRequests: number;
  readonly bytesTransferred: number;
  readonly errors: XClientStats['errors'];

  readonly estimatedCostPer1kResults: CostEstimate;
  readonly wallClockMs: number;
}

export interface CostEstimate {
  readonly proxyGB: number;
  readonly computeUnits: number;
  readonly usd: number;
}

/** Apify list prices, named so the USD figure's assumptions are visible and correctable. */
export const PRICING = {
  usdPerResidentialProxyGB: 12.5,
  usdPerComputeUnit: 0.4,
} as const;

export interface SummaryInputs {
  readonly requestedMaxResults: number;
  readonly requestBudget: number;
  readonly entitlement: Entitlement;
  readonly collect: CollectStats;
  readonly crawl: CrawlStats;
  readonly hydrate: HydrateStats;
  readonly client: XClientStats;
  readonly transfer: TransferStats;
  readonly discoveryStrategy: string;
  readonly tokensConsumed: number;
  readonly wallClockMs: number;
  readonly memoryMbytes: number | null;
}

export function buildRunSummary(inputs: SummaryInputs): RunSummary {
  const { collect, crawl, client } = inputs;
  const pushed = collect.pushed;

  return {
    requested: inputs.requestedMaxResults,
    fetched: collect.fetched,
    pushed,
    requestBudget: inputs.requestBudget,

    limited: inputs.entitlement.limited,
    reason: inputs.entitlement.reason,
    cap: inputs.entitlement.cap,

    hydratedById: inputs.hydrate,

    discoveryStrategy: inputs.discoveryStrategy,
    discoveryRequests: crawl.discoveryRequests,
    seedsResolved: crawl.seedsResolved,
    accountsCrawled: crawl.accountsCrawled,
    handlesDiscovered: crawl.handlesDiscovered,
    pagesFetched: crawl.pagesFetched,

    filteredOut: collect.filteredOut,
    // The fraction of what we paid to fetch that survived the filters.
    selectivity: collect.fetched === 0 ? 0 : round(pushed / collect.fetched, 4),
    duplicatesDropped: collect.duplicatesDropped,

    accountsSkipped: crawl.accountsSkipped,
    budgetExhausted: crawl.budgetExhausted,
    tokensConsumed: inputs.tokensConsumed,
    xRequests: client.requests,
    totalRequests: inputs.transfer.requests,
    bytesTransferred: inputs.transfer.bytes,
    errors: client.errors,

    estimatedCostPer1kResults: estimateCost({
      bytes: inputs.transfer.bytes,
      pushed,
      wallClockMs: inputs.wallClockMs,
      memoryMbytes: inputs.memoryMbytes,
    }),
    wallClockMs: inputs.wallClockMs,
  };
}

/**
 * Extrapolated from this run's measured bytes and wall clock.
 *
 * The extrapolation is linear and part of the cost is not: cold start is paid once
 * regardless of run size, so a small run overstates the per-1k figure. Read it alongside
 * `bytesTransferred`, and only trust it for runs large enough to amortise cold start.
 */
export function estimateCost(inputs: {
  bytes: number;
  pushed: number;
  wallClockMs: number;
  memoryMbytes: number | null;
}): CostEstimate {
  if (inputs.pushed === 0) return { proxyGB: 0, computeUnits: 0, usd: 0 };

  const scale = 1000 / inputs.pushed;
  const proxyGB = (inputs.bytes * scale) / 1_000_000_000;

  // A compute unit is 1 GB of memory for 1 hour.
  const memoryGB = (inputs.memoryMbytes ?? 1024) / 1024;
  const computeUnits = memoryGB * ((inputs.wallClockMs * scale) / 3_600_000);

  const usd = proxyGB * PRICING.usdPerResidentialProxyGB + computeUnits * PRICING.usdPerComputeUnit;

  return { proxyGB: round(proxyGB, 4), computeUnits: round(computeUnits, 4), usd: round(usd, 4) };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
