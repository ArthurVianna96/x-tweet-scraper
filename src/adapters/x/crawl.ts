import { mergeConcurrent } from '../../domain/merge-concurrent.js';
import type { Tweet } from '../../domain/types.js';
import type { DiscoveryStrategy } from '../discovery/types.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';
import { normalizeTweet } from './normalizer.js';
import { fetchUserProfile, streamUserTweets } from './operations.js';

/**
 * The crawl: discovery → `UserByScreenName` → `UserTweets` (cursored) → normalized
 * tweets, N accounts at a time (SPEC.md §2, §6).
 *
 * It is a generator on purpose. Nothing is fetched until the consumer pulls, so the
 * free-tier cap stops the crawl rather than truncating its output, and a consumer that
 * breaks unwinds every in-flight account chain (§4.3).
 */

export interface CrawlOptions {
  readonly client: XClient;
  readonly discovery: DiscoveryStrategy;
  /** Account chains in flight at once. A cursor chain cannot be parallelised internally. */
  readonly concurrency?: number;
  readonly maxPagesPerAccount?: number;
  readonly maxAccounts?: number;
  /**
   * Hard ceiling on X requests for the whole run.
   *
   * This is a cost control, and it is not optional in practice. Measured on a real
   * keyword run before it existed: `searchTerms: ["web scraping"]` against seeded
   * accounts matched 9 tweets out of 10,527 fetched — a selectivity of 0.09% — and spent
   * 518 requests and 91 MB of proxy traffic getting there. Low-selectivity filters are
   * normal, and without a budget the run's cost is bounded only by how many accounts
   * exist (SPEC.md §6).
   */
  readonly maxRequests?: number;
  /**
   * Snowball depth. One `UserTweets` page names ~37 distinct handles through mentions
   * and retweeted authors, at zero extra request cost — that data is already in a
   * response we paid for. Depth is limited (default 1) because mentions from a topical
   * account are not all topical, and precision decays fast.
   */
  readonly expansionDepth?: number;
  /** Cursors from a previous incarnation of this run, by handle (SPEC.md §5.3). */
  readonly cursors?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
  readonly onEvent?: (event: CrawlEvent) => void;
}

export type CrawlEvent =
  | { readonly type: 'seeds'; readonly strategy: string; readonly handles: readonly string[] }
  | { readonly type: 'account-start'; readonly handle: string; readonly depth: number }
  | { readonly type: 'account-skipped'; readonly handle: string; readonly reason: string }
  | { readonly type: 'page'; readonly handle: string; readonly tweets: number };

export interface CrawlStats {
  seedsResolved: number;
  accountsCrawled: number;
  pagesFetched: number;
  discoveryRequests: number;
  handlesDiscovered: number;
  accountsSkipped: { protected: number; suspended: number; notFound: number };
  /** True when the run stopped because it hit its request budget, not because it finished. */
  budgetExhausted: boolean;
  /** Live cursor per handle, for checkpointing. */
  readonly cursors: Record<string, string>;
}

export class Crawler {
  readonly stats: CrawlStats = {
    seedsResolved: 0,
    accountsCrawled: 0,
    pagesFetched: 0,
    discoveryRequests: 0,
    handlesDiscovered: 0,
    accountsSkipped: { protected: 0, suspended: 0, notFound: 0 },
    budgetExhausted: false,
    cursors: {},
  };

  constructor(private readonly opts: CrawlOptions) {}

  private get maxDepth(): number {
    return this.opts.expansionDepth ?? 1;
  }

  /** @returns true when the run has spent its request budget and must wind down. */
  private outOfBudget(): boolean {
    const max = this.opts.maxRequests;
    if (max === undefined) return false;
    if (this.opts.client.stats.requests < max) return false;

    this.stats.budgetExhausted = true;
    return true;
  }

  async *tweets(): AsyncGenerator<Tweet> {
    const discovered = await this.opts.discovery.discover();
    this.stats.seedsResolved = discovered.handles.length;
    this.stats.discoveryRequests = discovered.requests;
    this.opts.onEvent?.({
      type: 'seeds',
      strategy: this.opts.discovery.name,
      handles: discovered.handles,
    });

    const maxAccounts = this.opts.maxAccounts ?? 50;
    const visited = new Set<string>();

    let frontier = dedupeHandles(discovered.handles);
    const nextFrontier: string[] = [];

    for (let depth = 0; depth <= this.maxDepth && frontier.length > 0; depth++) {
      if (this.outOfBudget()) return;

      const batch = frontier
        .filter((handle) => !visited.has(handle.toLowerCase()))
        .slice(0, Math.max(0, maxAccounts - visited.size));

      for (const handle of batch) visited.add(handle.toLowerCase());
      if (batch.length === 0) break;

      /**
       * Parallelising *across accounts* is the equivalent of time-window sharding a
       * search query: it is the only axis available, because page 2 of a timeline needs
       * page 1's cursor (SPEC.md §6).
       */
      yield* mergeConcurrent(
        batch.map(
          (handle) => () => this.account(handle, depth, nextFrontier)[Symbol.asyncIterator](),
        ),
        this.opts.concurrency ?? 4,
      );

      frontier = dedupeHandles(nextFrontier.splice(0));
      this.stats.handlesDiscovered += frontier.length;
    }
  }

  private async *account(
    handle: string,
    depth: number,
    nextFrontier: string[],
  ): AsyncGenerator<Tweet> {
    if (this.outOfBudget()) return;
    this.opts.onEvent?.({ type: 'account-start', handle, depth });

    try {
      const user = await fetchUserProfile(this.opts.client, handle);

      if (user.protected) {
        // A protected account is readable as a profile but not as a timeline. Counting
        // and skipping is the whole "graceful degradation" requirement (brief §7, §11).
        this.stats.accountsSkipped.protected++;
        this.opts.onEvent?.({ type: 'account-skipped', handle, reason: 'protected' });
        return;
      }

      this.stats.accountsCrawled++;
      const startCursor = this.opts.cursors?.[handle.toLowerCase()] ?? null;

      const stream = streamUserTweets(
        this.opts.client,
        {
          userId: user.id,
          handle: user.username,
          startCursor,
          ...(this.opts.maxPagesPerAccount === undefined
            ? {}
            : { maxPages: this.opts.maxPagesPerAccount }),
        },
        (page) => {
          this.stats.pagesFetched++;
          if (page.cursor !== null) this.stats.cursors[handle.toLowerCase()] = page.cursor;
          this.opts.onEvent?.({ type: 'page', handle, tweets: page.count });
        },
      );

      for await (const raw of stream) {
        const tweet = normalizeTweet(
          raw,
          this.opts.now === undefined ? {} : { now: this.opts.now },
        );
        if (tweet === null) continue;

        if (depth < this.maxDepth) collectExpansion(tweet, nextFrontier);
        yield tweet;

        // Checked after yielding so the tweets already paid for are not thrown away.
        if (this.outOfBudget()) return;
      }
    } catch (err) {
      // One dead account never fails the run.
      if (err instanceof TargetUnavailableError) {
        const bucket =
          err.kind === 'suspended'
            ? 'suspended'
            : err.kind === 'protected'
              ? 'protected'
              : 'notFound';
        this.stats.accountsSkipped[bucket]++;
        this.opts.onEvent?.({ type: 'account-skipped', handle, reason: err.kind });
        return;
      }
      throw err;
    }
  }
}

/**
 * Seed expansion, native and free: mentions and retweeted authors are already in the
 * page we paid for, so growing the frontier costs zero extra requests.
 */
function collectExpansion(tweet: Tweet, frontier: string[]): void {
  for (const mention of tweet.entities.mentions) frontier.push(mention);
}

function dedupeHandles(handles: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const raw of handles) {
    const handle = raw.trim().replace(/^@/, '');
    const key = handle.toLowerCase();
    if (handle.length === 0 || seen.has(key)) continue;
    seen.add(key);
    output.push(handle);
  }

  return output;
}
