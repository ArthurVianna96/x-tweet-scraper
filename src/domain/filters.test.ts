import { describe, expect, it } from 'vitest';

import { matchesFilters, sortTweets, type FilterCriteria } from './filters.js';
import { snowflakeAtMs } from './snowflake.js';
import type { Tweet, TweetMedia } from './types.js';

/** An ID that decodes to exactly this instant, so date filters can be tested precisely. */
const idAt = (iso: string): string => snowflakeAtMs(new Date(iso).getTime()).toString();

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: idAt('2026-08-14T12:00:00.000Z'),
    url: 'https://x.com/tester/status/1',
    text: 'A tweet about scraping and data',
    lang: 'en',
    createdAt: '2026-08-14T12:00:00.000Z',
    conversationId: '1',
    isReply: false,
    isRetweet: false,
    isQuote: false,
    inReplyToId: null,
    quotedTweetId: null,
    author: {
      id: '10',
      username: 'tester',
      name: 'Tester',
      verified: false,
      followers: 100,
      following: 50,
    },
    metrics: { likes: 10, retweets: 5, replies: 2, quotes: 0, bookmarks: 0, views: 1000 },
    entities: { hashtags: [], mentions: [], urls: [], media: [] },
    source: 'Twitter Web App',
    scrapedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

const photo: TweetMedia = { type: 'photo', url: 'https://p/1.jpg', thumbnail: 'https://p/1.jpg' };
const video: TweetMedia = { type: 'video', url: 'https://v/1.mp4', thumbnail: 'https://p/1.jpg' };
const gif: TweetMedia = {
  type: 'animated_gif',
  url: 'https://v/g.mp4',
  thumbnail: 'https://p/g.jpg',
};

const withMedia = (...media: TweetMedia[]) =>
  tweet({ entities: { hashtags: [], mentions: [], urls: [], media } });

describe('an unspecified filter is no constraint', () => {
  it('accepts anything when no criteria are given', () => {
    expect(matchesFilters(tweet(), {})).toBe(true);
  });

  it('ignores empty arrays rather than treating them as "match nothing"', () => {
    expect(matchesFilters(tweet(), { searchTerms: [], hashtags: [], fromUsers: [] })).toBe(true);
  });
});

describe('replies and retweets both default to excluded', () => {
  // the spec states the default only for retweets; we default both to false and document it.
  it('drops replies unless includeReplies is true', () => {
    const reply = tweet({ isReply: true, inReplyToId: '9' });
    expect(matchesFilters(reply, {})).toBe(false);
    expect(matchesFilters(reply, { includeReplies: true })).toBe(true);
  });

  it('drops retweets unless includeRetweets is true', () => {
    const retweet = tweet({ isRetweet: true });
    expect(matchesFilters(retweet, {})).toBe(false);
    expect(matchesFilters(retweet, { includeRetweets: true })).toBe(true);
  });
});

describe('searchTerms', () => {
  it('matches case-insensitively against the normalized text', () => {
    expect(matchesFilters(tweet(), { searchTerms: ['SCRAPING'] })).toBe(true);
    expect(matchesFilters(tweet(), { searchTerms: ['kubernetes'] })).toBe(false);
  });

  it('treats multiple terms as OR', () => {
    expect(matchesFilters(tweet(), { searchTerms: ['kubernetes', 'scraping'] })).toBe(true);
  });
});

describe('hashtags', () => {
  const tagged = tweet({
    entities: { hashtags: ['WebScraping', 'Data'], mentions: [], urls: [], media: [] },
  });

  it('matches case-insensitively, with or without the leading #', () => {
    expect(matchesFilters(tagged, { hashtags: ['webscraping'] })).toBe(true);
    expect(matchesFilters(tagged, { hashtags: ['#WEBSCRAPING'] })).toBe(true);
    expect(matchesFilters(tagged, { hashtags: ['python'] })).toBe(false);
  });
});

describe('people filters', () => {
  const reply = tweet({
    isReply: true,
    inReplyToId: '9',
    entities: { hashtags: [], mentions: ['apify', 'someone'], urls: [], media: [] },
  });

  it('fromUsers matches the author, ignoring @ and case', () => {
    expect(matchesFilters(tweet(), { fromUsers: ['@Tester'] })).toBe(true);
    expect(matchesFilters(tweet(), { fromUsers: ['someoneelse'] })).toBe(false);
  });

  it('an unset fromUsers constrains nothing', () => {
    expect(matchesFilters(reply, { includeReplies: true })).toBe(true);
    expect(matchesFilters(tweet(), {})).toBe(true);
  });
});

describe('engagement floors are inclusive', () => {
  it('accepts a tweet sitting exactly on the floor', () => {
    expect(matchesFilters(tweet(), { minLikes: 10 })).toBe(true);
    expect(matchesFilters(tweet(), { minLikes: 11 })).toBe(false);
    expect(matchesFilters(tweet(), { minRetweets: 5 })).toBe(true);
    expect(matchesFilters(tweet(), { minReplies: 2 })).toBe(true);
  });

  it('treats a missing metric as zero', () => {
    const noCounts = tweet({
      metrics: {
        likes: null,
        retweets: null,
        replies: null,
        quotes: null,
        bookmarks: null,
        views: null,
      },
    });
    expect(matchesFilters(noCounts, { minLikes: 1 })).toBe(false);
    expect(matchesFilters(noCounts, {})).toBe(true);
  });
});

describe('language and verification', () => {
  it('filters on X’s own language detection', () => {
    expect(matchesFilters(tweet(), { language: 'en' })).toBe(true);
    expect(matchesFilters(tweet(), { language: 'pt' })).toBe(false);
  });

  it('onlyVerified keeps verified authors', () => {
    const verified = tweet({ author: { ...tweet().author, verified: true } });
    expect(matchesFilters(verified, { onlyVerified: true })).toBe(true);
    expect(matchesFilters(tweet(), { onlyVerified: true })).toBe(false);
    // Unspecified means no constraint — verified authors are not excluded.
    expect(matchesFilters(verified, {})).toBe(true);
  });
});

describe('mediaType rulings', () => {
  it('images matches any tweet with at least one photo, other content allowed', () => {
    expect(matchesFilters(withMedia(photo), { mediaType: 'images' })).toBe(true);
    expect(matchesFilters(withMedia(photo, video), { mediaType: 'images' })).toBe(true);
    expect(matchesFilters(withMedia(video), { mediaType: 'images' })).toBe(false);
  });

  it('groups animated_gif under video, because X stores GIFs as MP4', () => {
    expect(matchesFilters(withMedia(gif), { mediaType: 'video' })).toBe(true);
    expect(matchesFilters(withMedia(gif), { mediaType: 'images' })).toBe(false);
  });

  it('links matches any tweet carrying at least one URL', () => {
    const linked = tweet({
      entities: { hashtags: [], mentions: [], urls: ['https://example.com'], media: [] },
    });
    expect(matchesFilters(linked, { mediaType: 'links' })).toBe(true);
    expect(matchesFilters(tweet(), { mediaType: 'links' })).toBe(false);
  });

  it('text_only excludes links as well as media', () => {
    const linked = tweet({
      entities: { hashtags: [], mentions: [], urls: ['https://example.com'], media: [] },
    });
    expect(matchesFilters(tweet(), { mediaType: 'text_only' })).toBe(true);
    expect(matchesFilters(linked, { mediaType: 'text_only' })).toBe(false);
    expect(matchesFilters(withMedia(photo), { mediaType: 'text_only' })).toBe(false);
  });
});

describe('since / until are inclusive', () => {
  const day = (iso: string) => tweet({ id: idAt(iso) });

  it('includes a tweet on the exact since instant', () => {
    const t = day('2026-08-14T00:00:00.000Z');
    expect(matchesFilters(t, { since: '2026-08-14T00:00:00.000Z' })).toBe(true);
    expect(matchesFilters(t, { since: '2026-08-14T00:00:00.001Z' })).toBe(false);
  });

  it('treats a bare date in `until` as the whole day', () => {
    // The off-by-one that silently drops a day: `until: 2026-08-14` must not mean
    // midnight.
    expect(matchesFilters(day('2026-08-14T23:59:59.000Z'), { until: '2026-08-14' })).toBe(true);
    expect(matchesFilters(day('2026-08-15T00:00:01.000Z'), { until: '2026-08-14' })).toBe(false);
  });

  it('applies both bounds together', () => {
    const criteria: FilterCriteria = { since: '2026-08-10', until: '2026-08-14' };
    expect(matchesFilters(day('2026-08-12T09:00:00.000Z'), criteria)).toBe(true);
    expect(matchesFilters(day('2026-08-09T23:00:00.000Z'), criteria)).toBe(false);
    expect(matchesFilters(day('2026-08-15T00:00:00.000Z'), criteria)).toBe(false);
  });
});

describe('filters combine with AND', () => {
  it('requires every specified filter to pass', () => {
    const target = tweet({
      entities: { hashtags: ['data'], mentions: ['apify'], urls: [], media: [] },
      metrics: { likes: 50, retweets: 5, replies: 2, quotes: 0, bookmarks: 0, views: 10 },
    });

    const criteria: FilterCriteria = {
      searchTerms: ['scraping'],
      hashtags: ['data'],
      minLikes: 50,
      language: 'en',
    };

    expect(matchesFilters(target, criteria)).toBe(true);
    // One failing clause fails the whole conjunction.
    expect(matchesFilters(target, { ...criteria, minLikes: 51 })).toBe(false);
    expect(matchesFilters(target, { ...criteria, hashtags: ['python'] })).toBe(false);
  });
});

describe('sortTweets', () => {
  const older = tweet({
    id: idAt('2026-08-10T00:00:00.000Z'),
    metrics: { ...tweet().metrics, likes: 900 },
  });
  const newer = tweet({
    id: idAt('2026-08-16T00:00:00.000Z'),
    metrics: { ...tweet().metrics, likes: 1 },
  });

  it('latest is a descending Snowflake sort — IDs are monotonic, so ID order is time order', () => {
    expect(sortTweets([older, newer], 'latest').map((t) => t.id)).toEqual([newer.id, older.id]);
  });

  it('top ranks by likes + retweets within the collected set', () => {
    expect(sortTweets([newer, older], 'top').map((t) => t.id)).toEqual([older.id, newer.id]);
  });

  it('does not mutate its input', () => {
    const input = [newer, older];
    sortTweets(input, 'top');
    expect(input.map((t) => t.id)).toEqual([newer.id, older.id]);
  });
});
