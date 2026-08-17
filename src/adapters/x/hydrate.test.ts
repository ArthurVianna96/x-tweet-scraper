import { describe, expect, it } from 'vitest';

import { loadFixture } from '../../../test/support/fixtures.js';
import { TargetUnavailableError } from './errors.js';
import type { XClient } from './graphql.js';
import { TweetHydrator } from './hydrate.js';

/**
 * The by-id surface. The client is a stub, so this is offline and asserts
 * the two things that matter: one request per distinct id, and one dead id never
 * failing a run of many.
 */

const REAL_PAYLOAD = loadFixture('tweet-by-id') as { data: { tweetResult: { result: unknown } } };
const REAL_ID = (REAL_PAYLOAD.data.tweetResult.result as { rest_id: string }).rest_id;

function stubClient(responder: (tweetId: string) => unknown): {
  client: XClient;
  requested: string[];
} {
  const requested: string[] = [];

  const stats = { requests: 0, bytes: 0, errors: {} };
  const client = {
    stats,
    async call(_operation: string, variables: Record<string, unknown>) {
      const id = String(variables['tweetId']);
      requested.push(id);
      stats.requests++;
      return responder(id);
    },
  } as unknown as XClient;

  return { client, requested };
}

/** X answers an unknown id with an empty `tweetResult`, not with an error. */
const EMPTY = { data: { tweetResult: {} } };

async function drain(hydrator: TweetHydrator): Promise<string[]> {
  const ids: string[] = [];
  for await (const tweet of hydrator.tweets()) ids.push(tweet.id);
  return ids;
}

describe('TweetHydrator', () => {
  it('normalizes a real TweetResultByRestId payload to the output contract', async () => {
    const { client } = stubClient(() => REAL_PAYLOAD);
    const hydrator = new TweetHydrator({
      client,
      tweetIds: [REAL_ID],
      now: () => new Date('2026-08-17T10:15:00.000Z'),
    });

    const tweets = [];
    for await (const tweet of hydrator.tweets()) tweets.push(tweet);

    expect(tweets).toHaveLength(1);
    const [tweet] = tweets;
    expect(tweet?.id).toBe(REAL_ID);
    // The by-id payload carries the same object a timeline entry does, which is the
    // whole reason `normalizeTweet` reads it unchanged.
    expect(tweet?.url).toBe(`https://x.com/${tweet?.author.username}/status/${REAL_ID}`);
    expect(tweet?.author.id).not.toBeNull();
    expect(tweet?.author.username).not.toBeNull();
    expect(tweet?.text.length).toBeGreaterThan(0);
    expect(tweet?.scrapedAt).toBe('2026-08-17T10:15:00.000Z');
    expect(hydrator.stats).toMatchObject({ requested: 1, hydrated: 1, missing: 0 });
  });

  it('spends one request per distinct id, and dedupes repeats', async () => {
    const { client, requested } = stubClient(() => REAL_PAYLOAD);
    const hydrator = new TweetHydrator({ client, tweetIds: [REAL_ID, REAL_ID, ` ${REAL_ID} `] });

    await drain(hydrator);

    expect(requested).toEqual([REAL_ID]);
    expect(hydrator.stats).toMatchObject({ requested: 1, hydrated: 1, missing: 0 });
  });

  it('counts an id X has no tweet for, and keeps going', async () => {
    const { client } = stubClient((id) => (id === '1' ? EMPTY : REAL_PAYLOAD));
    const hydrator = new TweetHydrator({ client, tweetIds: ['1', REAL_ID] });

    expect(await drain(hydrator)).toEqual([REAL_ID]);
    expect(hydrator.stats).toMatchObject({ requested: 2, hydrated: 1, missing: 1 });
  });

  it('a suspended or deleted target is skipped, never fatal', async () => {
    const { client } = stubClient((id) => {
      if (id === '1') throw new TargetUnavailableError('1', 'suspended');
      return REAL_PAYLOAD;
    });
    const hydrator = new TweetHydrator({ client, tweetIds: ['1', REAL_ID] });

    expect(await drain(hydrator)).toEqual([REAL_ID]);
    expect(hydrator.stats.missing).toBe(1);
  });

  it('is lazy, so the free-tier cap stops the fetching', async () => {
    const { client, requested } = stubClient(() => REAL_PAYLOAD);
    const ids = Array.from({ length: 100 }, (_, i) => String(1000 + i));
    const hydrator = new TweetHydrator({ client, tweetIds: ids });

    // A consumer that stops after one item must not have paid for the other 99.
    for await (const _tweet of hydrator.tweets()) break;

    expect(requested).toHaveLength(1);
  });

  it('stops at the request budget rather than working through every id', async () => {
    const { client, requested } = stubClient(() => REAL_PAYLOAD);
    const ids = Array.from({ length: 50 }, (_, i) => String(2000 + i));
    const hydrator = new TweetHydrator({ client, tweetIds: ids, maxRequests: 5 });

    await drain(hydrator);

    expect(requested).toHaveLength(5);
  });

  it('ignores ids that are not snowflakes rather than spending a request on them', async () => {
    const { client, requested } = stubClient(() => REAL_PAYLOAD);
    const hydrator = new TweetHydrator({ client, tweetIds: ['not-an-id', '', REAL_ID] });

    await drain(hydrator);

    expect(requested).toEqual([REAL_ID]);
  });
});
