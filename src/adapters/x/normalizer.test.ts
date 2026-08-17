import { describe, expect, it } from 'vitest';

import { loadTweet } from '../../../test/support/fixtures.js';
import { normalizeTweet, parseTwitterDate } from './normalizer.js';

const at = (iso: string) => ({ now: () => new Date(iso) });
const FIXED = at('2026-08-17T00:00:00.000Z');

const normalize = (name: string) => {
  const tweet = normalizeTweet(loadTweet(name), FIXED);
  if (tweet === null) throw new Error(`fixture ${name} did not normalize`);
  return tweet;
};

describe('retweets', () => {
  const retweet = normalize('tweet-retweet');
  const raw = loadTweet('tweet-retweet') as {
    legacy: {
      full_text: string;
      favorite_count: number;
      retweeted_status_result: {
        result: { legacy: { full_text: string; favorite_count: number } };
      };
    };
  };

  it('emits the original text, never the "RT @handle:" wrapper', () => {
    const original = raw.legacy.retweeted_status_result.result.legacy.full_text;

    expect(raw.legacy.full_text).toMatch(/^RT @/);
    expect(retweet.isRetweet).toBe(true);
    expect(retweet.text).not.toMatch(/^RT @/);

    // Same content as the original, differing only where t.co links were expanded.
    expect(retweet.text.startsWith(original.split('https://t.co/')[0] ?? '')).toBe(true);
    expect(retweet.text).not.toMatch(/https:\/\/t\.co\//);
  });

  it('takes metrics from the original, because the wrapper reads zero', () => {
    // The measured trap: this retweet's wrapper says 0 likes, the original says 13.
    // Reading the wrapper would make `minLikes: 1` discard every retweet in the run.
    expect(raw.legacy.favorite_count).toBe(0);
    expect(raw.legacy.retweeted_status_result.result.legacy.favorite_count).toBeGreaterThan(0);
    expect(retweet.metrics.likes).toBe(
      raw.legacy.retweeted_status_result.result.legacy.favorite_count,
    );
  });

  it('keeps the retweet’s own identity, author and timestamp', () => {
    expect(retweet.id).toBe('2088525549626867786');
    expect(retweet.author.username).toBe('apify');
    expect(retweet.url).toBe(`https://x.com/apify/status/${retweet.id}`);
  });
});

describe('long-form posts', () => {
  const longForm = normalize('tweet-long-form');
  const raw = loadTweet('tweet-long-form') as {
    legacy: { full_text: string; display_text_range: [number, number] };
    note_tweet: { note_tweet_results: { result: { text: string } } };
  };

  it('emits note_tweet text rather than the truncated legacy.full_text', () => {
    expect(longForm.text).toBe(raw.note_tweet.note_tweet_results.result.text);
    expect(longForm.text).not.toBe(raw.legacy.full_text);
  });

  it('does not pick the longer string — the truncated one can be longer', () => {
    // Measured: legacy 302 chars vs note 283. `legacy.full_text` is longer only because
    // X appended a 23-char t.co pointer to the text it cut off; `display_text_range`
    // ends at 278. A "take whichever is longer" rule would emit the truncated version.
    expect(raw.legacy.full_text.length).toBeGreaterThan(
      raw.note_tweet.note_tweet_results.result.text.length,
    );
    expect(raw.legacy.full_text).toMatch(/https:\/\/t\.co\/\w+$/);
    expect(raw.legacy.display_text_range[1]).toBeLessThan(raw.legacy.full_text.length);
  });
});

describe('the output contract', () => {
  const names = [
    'tweet-retweet',
    'tweet-long-form',
    'tweet-media',
    'tweet-quote',
    'tweet-reply',
    'tweet-links',
    'tweet-plain',
  ];

  it.each(names)('%s conforms — every field present, absences are null', (name) => {
    const tweet = normalize(name) as unknown as Record<string, unknown>;

    const required = [
      'id',
      'url',
      'text',
      'lang',
      'createdAt',
      'conversationId',
      'isReply',
      'isRetweet',
      'isQuote',
      'inReplyToId',
      'quotedTweetId',
      'author',
      'metrics',
      'entities',
      'source',
      'scrapedAt',
    ];

    for (const field of required) {
      expect(field in tweet).toBe(true);
      expect(tweet[field]).not.toBeUndefined();
    }

    for (const group of ['author', 'metrics'] as const) {
      for (const value of Object.values(tweet[group] as Record<string, unknown>)) {
        expect(value).not.toBeUndefined();
      }
    }
  });

  it.each(names)('%s emits ids as strings and timestamps as ISO-8601 UTC', (name) => {
    const tweet = normalize(name);

    expect(typeof tweet.id).toBe('string');
    expect(tweet.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(tweet.scrapedAt).toBe('2026-08-17T00:00:00.000Z');
  });

  it('reads follower counts from relationship_counts, not the removed legacy field', () => {
    const tweet = normalize('tweet-plain');
    const raw = loadTweet('tweet-plain') as {
      core: { user_results: { result: Record<string, unknown> } };
    };
    const user = raw.core.user_results.result as {
      relationship_counts: { followers: number };
      legacy?: { followers_count?: number };
    };

    // `legacy.followers_count` is gone from X's payloads; scrapers still reading it emit
    // null here.
    expect(user.legacy?.followers_count).toBeUndefined();
    expect(tweet.author.followers).toBe(user.relationship_counts.followers);
    expect(typeof tweet.author.followers).toBe('number');
  });

  it('coerces views from the string X actually sends', () => {
    const raw = loadTweet('tweet-long-form') as { views: { count: string } };
    expect(typeof raw.views.count).toBe('string');
    expect(normalize('tweet-long-form').metrics.views).toBe(Number(raw.views.count));
  });

  it('emits null — not undefined — for a tweet X serves without a view count', () => {
    // Not every tweet carries `views`; the column must still exist and be null.
    const raw = loadTweet('tweet-plain') as { views?: { count?: string } };
    expect(raw.views?.count).toBeUndefined();
    expect(normalize('tweet-plain').metrics.views).toBeNull();
  });

  it('strips the HTML wrapper off `source`', () => {
    const raw = loadTweet('tweet-plain') as { source: string };
    expect(raw.source).toMatch(/^<a /);
    expect(normalize('tweet-plain').source).not.toMatch(/[<>]/);
  });

  it('expands t.co links, including the media link that lives in entities.media', () => {
    const withLinks = normalize('tweet-links');
    expect(withLinks.entities.urls.length).toBeGreaterThan(0);
    for (const url of withLinks.entities.urls) {
      expect(url).not.toMatch(/^https:\/\/t\.co\//);
    }
    // No t.co survives anywhere in the emitted text.
    expect(normalize('tweet-media').text).not.toMatch(/https:\/\/t\.co\//);
  });

  it('resolves a video to the media itself, keeping the poster frame as thumbnail', () => {
    const video = normalize('tweet-media').entities.media.find((m) => m.type === 'video');
    if (video === undefined) return; // fixture happened to capture photos only

    expect(video.url).toMatch(/\.mp4/);
    expect(video.thumbnail).not.toBe(video.url);
  });

  it('treats X’s Business verification as unverified, which the schema cannot distinguish', () => {
    const raw = loadTweet('tweet-plain') as {
      core: {
        user_results: {
          result: {
            is_blue_verified?: boolean;
            verification?: { verified: boolean; verified_type?: string };
          };
        };
      };
    };
    const user = raw.core.user_results.result;
    const expected = user.is_blue_verified === true || user.verification?.verified === true;

    // Never key off `verified_type`: @apify carries verified_type "Business" with
    // verified: false, and @grok carries the same while being blue-verified.
    expect(normalize('tweet-plain').author.verified).toBe(expected);
  });
});

describe('text decoding', () => {
  it('decodes &amp;, &lt; and &gt; last, after URL expansion', () => {
    const synthetic = {
      rest_id: '1',
      legacy: {
        full_text: 'Tom &amp; Jerry &lt;3 https://t.co/abc &gt;',
        entities: {
          urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/a?x=1&y=2' }],
        },
      },
      core: { user_results: { result: { core: { screen_name: 'tester' } } } },
    };

    const tweet = normalizeTweet(synthetic, FIXED);

    expect(tweet?.text).toBe('Tom & Jerry <3 https://example.com/a?x=1&y=2 >');
  });

  it('is unaffected by emoji, which desynchronise X’s code-point indices from JS', () => {
    const synthetic = {
      rest_id: '2',
      legacy: {
        full_text: '👅👅👅 see https://t.co/xyz',
        entities: { urls: [{ url: 'https://t.co/xyz', expanded_url: 'https://example.com/' }] },
      },
      core: { user_results: { result: { core: { screen_name: 'tester' } } } },
    };

    expect(normalizeTweet(synthetic, FIXED)?.text).toBe('👅👅👅 see https://example.com/');
  });
});

describe('parseTwitterDate', () => {
  it('parses X’s format explicitly rather than trusting new Date(string)', () => {
    expect(parseTwitterDate('Fri Aug 14 15:38:52 +0000 2026')).toBe('2026-08-14T15:38:52.000Z');
  });

  it('returns null for anything it does not recognise', () => {
    expect(parseTwitterDate('not a date')).toBeNull();
    expect(parseTwitterDate('Fri Xyz 14 15:38:52 +0000 2026')).toBeNull();
    expect(parseTwitterDate(null)).toBeNull();
  });
});

describe('malformed input', () => {
  it('returns null rather than throwing when there is no tweet there', () => {
    expect(normalizeTweet(null)).toBeNull();
    expect(normalizeTweet({})).toBeNull();
    expect(normalizeTweet({ rest_id: '1' })).toBeNull(); // no legacy block
    expect(normalizeTweet({ __typename: 'TweetTombstone' })).toBeNull();
  });

  it('unwraps TweetWithVisibilityResults', () => {
    const wrapped = {
      __typename: 'TweetWithVisibilityResults',
      tweet: {
        rest_id: '99',
        legacy: { full_text: 'hidden but readable', entities: {} },
        core: { user_results: { result: { core: { screen_name: 'tester' } } } },
      },
    };

    expect(normalizeTweet(wrapped, FIXED)?.id).toBe('99');
  });
});
