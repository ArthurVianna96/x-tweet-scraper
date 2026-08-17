import type { Tweet } from '../../domain/types.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';
import { normalizeTweet } from './normalizer.js';
import { fetchTweetById } from './operations.js';

/**
 * Tweet ids in, normalized tweets out. A generator for the same reason the crawl is one:
 * nothing is fetched until the consumer pulls, so the cap stops the fetching.
 */

export interface HydrateOptions {
  readonly client: XClient;
  readonly tweetIds: readonly string[];
  /** Shared with the crawl: a ceiling on X requests for the whole run. */
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
  /** Deleted, suspended, protected, or never existed. */
  missing: number;
}

export class TweetHydrator {
  readonly stats: HydrateStats = { requested: 0, hydrated: 0, missing: 0 };

  constructor(private readonly opts: HydrateOptions) {}

  async *tweets(): AsyncGenerator<Tweet> {
    // A repeated id is a wasted request the seen-set would discard anyway.
    const ids = [...new Set(this.opts.tweetIds.map((id) => id.trim()).filter(isTweetId))];
    this.stats.requested = ids.length;

    for (const id of ids) {
      if (this.outOfBudget()) return;

      let raw: unknown;
      try {
        raw = await fetchTweetById(this.opts.client, id);
      } catch (err) {
        // One dead id never fails a run of many.
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

/** Anything that is not decimal digits is a typo, not a tweet id. */
function isTweetId(value: string): boolean {
  return /^\d+$/.test(value);
}
