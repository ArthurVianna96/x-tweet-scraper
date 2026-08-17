import { mergeConcurrent } from '../../domain/merge-concurrent.js';
import type { Tweet } from '../../domain/types.js';
import type { DiscoveryStrategy } from '../discovery/types.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';
import { normalizeTweet } from './normalizer.js';
import { fetchUserProfile, streamUserTweets } from './operations.js';

/**
 * discovery → profile → timeline pages → normalized tweets, N accounts at a time.
 *
 * A generator on purpose: nothing is fetched until the consumer pulls, so the cap stops
 * the crawl rather than truncating its output.
 */

export interface CrawlOptions {
  readonly client: XClient;
  readonly discovery: DiscoveryStrategy;
  /** Account chains in flight at once; a single chain cannot be parallelised. */
  readonly concurrency?: number;
  readonly maxPagesPerAccount?: number;
  readonly maxAccounts?: number;
  /** Without this, a low-selectivity run costs whatever the account frontier costs. */
  readonly maxRequests?: number;
  /**
   * Snowball depth. Mentions and retweeted authors are already in pages we paid for, so
   * the frontier grows free. Kept shallow because precision decays fast.
   */
  readonly expansionDepth?: number;
  /** Cursors from an earlier incarnation of this run, by handle. */
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
  /** The run stopped on its request budget rather than finishing. */
  budgetExhausted: boolean;
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

  /** @returns true when the request budget is spent and the run must wind down. */
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

      // Across accounts is the only axis available: page 2 needs page 1's cursor.
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
        // Readable as a profile, but not as a timeline.
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

        // After yielding, so tweets already paid for are not thrown away.
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

/** Free: these handles are already in a page we paid for. */
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
