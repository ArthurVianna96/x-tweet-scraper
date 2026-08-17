import type { Tweet } from '../../domain/types.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';
import { normalizeTweet } from './normalizer.js';
import { fetchTweetById } from './operations.js';

/**
 * The by-id surface as a source (brief §2a): tweet ids in, normalized tweets out.
 *
 * It is a generator for the same reason the crawl is one — nothing is fetched until the
 * consumer pulls, so the free-tier cap stops the *fetching* rather than truncating the
 * output (SPEC.md §4.3). A free user who supplies 1,000 ids pays for 10 requests, not
 * 1,000.
 */

export interface HydrateOptions {
  readonly client: XClient;
  readonly tweetIds: readonly string[];
  /** Shared with the crawl: a hard ceiling on X requests for the whole run. */
  readonly maxRequests?: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: HydrateEvent) => void;
}

export type HydrateEvent =
  | { readonly type: 'hydrated'; readonly tweetId: string }
  | { readonly type: 'missing'; readonly tweetId: string; readonly reason: string };

export interface HydrateStats {
  requested: number;
  hydrated: number;
  /** Ids X returned nothing for: deleted, suspended author, protected, or never existed. */
  missing: number;
}

export class TweetHydrator {
  readonly stats: HydrateStats = { requested: 0, hydrated: 0, missing: 0 };

  constructor(private readonly opts: HydrateOptions) {}

  async *tweets(): AsyncGenerator<Tweet> {
    // Ids repeat in hand-written input more often than handles do, and a duplicate is a
    // wasted request that the global seen-set would discard anyway.
    const ids = [...new Set(this.opts.tweetIds.map((id) => id.trim()).filter(isTweetId))];
    this.stats.requested = ids.length;

    for (const id of ids) {
      if (this.outOfBudget()) return;

      let raw: unknown;
      try {
        raw = await fetchTweetById(this.opts.client, id);
      } catch (err) {
        // One dead id never fails a run of many — the same rule the crawl applies to
        // one dead account (brief §11).
        if (err instanceof TargetUnavailableError) {
          this.stats.missing++;
          this.opts.onEvent?.({ type: 'missing', tweetId: id, reason: err.kind });
          continue;
        }
        throw err;
      }

      const tweet = raw === null ? null : normalizeTweet(raw, this.nowOption());
      if (tweet === null) {
        this.stats.missing++;
        this.opts.onEvent?.({ type: 'missing', tweetId: id, reason: 'no tweet in response' });
        continue;
      }

      this.stats.hydrated++;
      this.opts.onEvent?.({ type: 'hydrated', tweetId: id });
      yield tweet;
    }
  }

  private nowOption(): { now?: () => Date } {
    return this.opts.now === undefined ? {} : { now: this.opts.now };
  }

  private outOfBudget(): boolean {
    const max = this.opts.maxRequests;
    return max !== undefined && this.opts.client.stats.requests >= max;
  }
}

/** Snowflake ids are decimal digits. Anything else is a typo, not a tweet. */
function isTweetId(value: string): boolean {
  return /^\d+$/.test(value);
}
