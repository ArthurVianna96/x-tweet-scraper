import { describe, expect, it } from 'vitest';

import type { DiscoveryStrategy } from '../discovery/types.js';
import { Crawler } from './crawl.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';

/**
 * Crawl behaviour with a stubbed client: budget enforcement, graceful degradation on dead
 * accounts, and snowball expansion. Offline and deterministic.
 */

const discovery = (handles: string[]): DiscoveryStrategy => ({
  name: 'stub',
  discover: async () => ({ handles, requests: 0 }),
});

interface StubOptions {
  /** Handles that should raise instead of resolving. */
  unavailable?: Record<string, 'protected' | 'suspended' | 'not_found'>;
  /** Handles whose profile reports `protected: true`. */
  protectedHandles?: string[];
  /** Tweets served per account, each mentioning `mention`. */
  tweetsPerAccount?: number;
  mention?: string;
}

function stubClient(opts: StubOptions = {}): XClient {
  const stats = {
    requests: 0,
    bytes: 0,
    errors: { '429': 0, '403': 0, '404': 0, '5xx': 0, timeout: 0, other: 0 },
  };
  let tweetId = 1000;

  const client = {
    stats,
    async call(
      operation: string,
      variables: Record<string, unknown>,
      context?: { target?: string },
    ) {
      stats.requests++;
      const handle = context?.target ?? '';

      if (operation === 'UserByScreenName') {
        const kind = opts.unavailable?.[handle];
        if (kind !== undefined) throw new TargetUnavailableError(handle, kind);

        return {
          data: {
            user: {
              result: {
                rest_id: `id-${handle}`,
                core: { screen_name: handle, name: handle },
                privacy: { protected: opts.protectedHandles?.includes(handle) === true },
              },
            },
          },
        };
      }

      // UserTweets: one page per account, no cursor, so each account ends after one page.
      const entries = Array.from({ length: opts.tweetsPerAccount ?? 2 }, () => ({
        entryId: `tweet-${++tweetId}`,
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: {
            tweet_results: {
              result: {
                rest_id: String(tweetId),
                core: { user_results: { result: { core: { screen_name: handle } } } },
                legacy: {
                  full_text: 'hello',
                  entities:
                    opts.mention === undefined
                      ? {}
                      : { user_mentions: [{ screen_name: opts.mention }] },
                },
              },
            },
          },
        },
      }));

      void variables;
      return {
        data: {
          user: {
            result: {
              timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
            },
          },
        },
      };
    },
  } as unknown as XClient;

  return client;
}

const drain = async (crawler: Crawler): Promise<number> => {
  let count = 0;
  for await (const _tweet of crawler.tweets()) count++;
  return count;
};

describe('request budget', () => {
  it('stops the crawl once the budget is spent and says so', async () => {
    // Without this the cost of a low-selectivity run is bounded only by how many accounts
    // exist: measured, a free keyword run spent 328 requests to deliver 9 results.
    const client = stubClient({ tweetsPerAccount: 2 });
    const handles = Array.from({ length: 50 }, (_, i) => `user${i}`);

    const crawler = new Crawler({
      client,
      discovery: discovery(handles),
      concurrency: 1,
      expansionDepth: 0,
      maxRequests: 10,
    });

    await drain(crawler);

    expect(crawler.stats.budgetExhausted).toBe(true);
    // Each account costs 2 requests (profile + one page), so 10 requests is ~5 accounts —
    // not the 50 it was handed.
    expect(client.stats.requests).toBeLessThanOrEqual(12);
    expect(crawler.stats.accountsCrawled).toBeLessThan(handles.length);
  });

  it('crawls everything when the budget is not binding', async () => {
    const client = stubClient({ tweetsPerAccount: 2 });
    const crawler = new Crawler({
      client,
      discovery: discovery(['a', 'b', 'c']),
      concurrency: 1,
      expansionDepth: 0,
      maxRequests: 500,
    });

    expect(await drain(crawler)).toBe(6);
    expect(crawler.stats.budgetExhausted).toBe(false);
    expect(crawler.stats.accountsCrawled).toBe(3);
  });
});

describe('graceful degradation', () => {
  it('counts and skips protected, suspended and missing accounts without failing', async () => {
    const client = stubClient({
      protectedHandles: ['locked'],
      unavailable: { gone: 'not_found', banned: 'suspended' },
      tweetsPerAccount: 2,
    });

    const crawler = new Crawler({
      client,
      discovery: discovery(['good', 'locked', 'gone', 'banned']),
      concurrency: 1,
      expansionDepth: 0,
    });

    // One healthy account still produces its tweets; three dead ones are accounted for.
    expect(await drain(crawler)).toBe(2);
    expect(crawler.stats.accountsSkipped).toEqual({ protected: 1, suspended: 1, notFound: 1 });
    expect(crawler.stats.accountsCrawled).toBe(1);
  });
});

describe('snowball expansion', () => {
  it('crawls handles mentioned by seed accounts at depth 1', async () => {
    const client = stubClient({ tweetsPerAccount: 1, mention: 'discovered' });

    const crawler = new Crawler({
      client,
      discovery: discovery(['seed']),
      concurrency: 1,
      expansionDepth: 1,
    });

    await drain(crawler);

    // Mentions are already in a page we paid for, so the frontier grows for free.
    expect(crawler.stats.accountsCrawled).toBe(2);
    expect(crawler.stats.handlesDiscovered).toBeGreaterThan(0);
  });

  it('does not expand when depth is 0', async () => {
    const client = stubClient({ tweetsPerAccount: 1, mention: 'discovered' });

    const crawler = new Crawler({
      client,
      discovery: discovery(['seed']),
      concurrency: 1,
      expansionDepth: 0,
    });

    await drain(crawler);
    expect(crawler.stats.accountsCrawled).toBe(1);
  });

  it('never revisits an account across depths', async () => {
    const client = stubClient({ tweetsPerAccount: 1, mention: 'seed' });

    const crawler = new Crawler({
      client,
      discovery: discovery(['seed']),
      concurrency: 1,
      expansionDepth: 2,
    });

    await drain(crawler);
    // The seed mentions itself; the visited-set must stop it looping.
    expect(crawler.stats.accountsCrawled).toBe(1);
  });
});
