import type { CollectStats } from '../domain/collect.js';
import type { Entitlement } from '../domain/entitlement.js';
import type { TransferStats } from '../adapters/http/counting.js';
import type { CrawlStats } from '../adapters/x/crawl.js';
import type { XClientStats } from '../adapters/x/graphql.js';

/**
 * The run summary (SPEC.md §7), written to `OUTPUT` and emitted as a structured log.
 *
 * It is designed so a reviewer can **re-derive** the performance claims rather than take
 * them on trust: requests, pages, bytes, selectivity, tokens consumed and the 429 count
 * are all reported, so the cost-per-1k figure can be checked against its inputs.
 */

export interface RunSummary {
  readonly requested: number;
  readonly fetched: number;
  readonly pushed: number;

  readonly limited: boolean;
  readonly reason: string | null;
  readonly cap: number | null;

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
  /** True when the run stopped on its request budget rather than on results or exhaustion. */
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

/**
 * Apify list prices at the time of writing. They are constants rather than magic numbers
 * precisely so a reader can see what the USD figure assumes and correct it for their own
 * plan — the number is only meaningful alongside its assumptions.
 */
export const PRICING = {
  usdPerResidentialProxyGB: 12.5,
  usdPerComputeUnit: 0.4,
} as const;

export interface SummaryInputs {
  readonly requestedMaxResults: number;
  readonly entitlement: Entitlement;
  readonly collect: CollectStats;
  readonly crawl: CrawlStats;
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

    limited: inputs.entitlement.limited,
    reason: inputs.entitlement.reason,
    cap: inputs.entitlement.cap,

    discoveryStrategy: inputs.discoveryStrategy,
    discoveryRequests: crawl.discoveryRequests,
    seedsResolved: crawl.seedsResolved,
    accountsCrawled: crawl.accountsCrawled,
    handlesDiscovered: crawl.handlesDiscovered,
    pagesFetched: crawl.pagesFetched,

    filteredOut: collect.filteredOut,
    // What fraction of everything we paid to fetch actually survived the filters. This
    // is the number that determines request budget, not the target result count.
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
 * Extrapolated from this run's measured bytes and wall clock, not from a guess. With
 * nothing pushed there is nothing to extrapolate from, so the estimate is zeroed rather
 * than divided by zero.
 *
 * **The extrapolation is linear, and part of a run's cost is not.** Cold start — the
 * ~1.8 MB queryId bundle and the first guest token — is paid once regardless of run size,
 * so a small run spreads it over few results and overstates the per-1k figure. Measured:
 * the same native path reports ~$2.19/1k on a 10-item free run and ~$0.41/1k on a
 * 100-item run. Treat the number as reliable only for runs large enough to amortise cold
 * start, and read `bytesTransferred` alongside it.
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

  // An Apify compute unit is 1 GB of memory for 1 hour.
  const memoryGB = (inputs.memoryMbytes ?? 1024) / 1024;
  const computeUnits = memoryGB * ((inputs.wallClockMs * scale) / 3_600_000);

  const usd = proxyGB * PRICING.usdPerResidentialProxyGB + computeUnits * PRICING.usdPerComputeUnit;

  return { proxyGB: round(proxyGB, 4), computeUnits: round(computeUnits, 4), usd: round(usd, 4) };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
