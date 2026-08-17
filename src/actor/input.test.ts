import { describe, expect, it } from 'vitest';

import { parseInput, toFilterCriteria, topicTerms } from './input.js';

describe('input validation (brief §4)', () => {
  it('requires at least one of searchTerms, fromUsers or hashtags', () => {
    expect(() => parseInput({})).toThrow(/At least one of/);
    expect(() => parseInput({ minLikes: 5 })).toThrow(/At least one of/);
    expect(() => parseInput({ searchTerms: ['scraping'] })).not.toThrow();
    expect(() => parseInput({ fromUsers: ['apify'] })).not.toThrow();
    expect(() => parseInput({ hashtags: ['data'] })).not.toThrow();
  });

  it('fails loudly with a readable message rather than scraping nothing quietly', () => {
    expect(() => parseInput({ fromUsers: ['apify'], minLikes: -1 })).toThrow(/minLikes/);
    expect(() => parseInput({ fromUsers: ['apify'], since: 'yesterday' })).toThrow(/ISO-8601/);
    expect(() => parseInput({ fromUsers: ['apify'], language: 'english' })).toThrow(/language/);
    expect(() => parseInput({ fromUsers: ['apify'], mediaType: 'gifs' })).toThrow(/mediaType/);
  });

  it('rejects a reversed date range', () => {
    expect(() =>
      parseInput({ fromUsers: ['apify'], since: '2026-08-14', until: '2026-08-01' }),
    ).toThrow(/must not be later/);
  });

  it('strips @ from handles and # from hashtags', () => {
    const input = parseInput({ fromUsers: ['@apify'], toUsers: ['@naval'], hashtags: ['#data'] });

    expect(input.fromUsers).toEqual(['apify']);
    expect(input.toUsers).toEqual(['naval']);
    expect(input.hashtags).toEqual(['data']);
  });

  it('defaults replies and retweets to excluded, and sortBy to latest', () => {
    const input = parseInput({ fromUsers: ['apify'] });

    expect(input.includeReplies).toBe(false);
    expect(input.includeRetweets).toBe(false);
    expect(input.sortBy).toBe('latest');
    expect(input.maxResults).toBe(100);
  });

  it('does not cap maxResults at the free-tier limit', () => {
    // A `"maximum": 10` here would break paying users, and a client-side limit is
    // exactly what brief §6 rejects as protection. The gate is server-side (SPEC.md §3.1).
    expect(parseInput({ fromUsers: ['apify'], maxResults: 100_000 }).maxResults).toBe(100_000);
  });

  it('carries a request budget so a low-selectivity run cannot cost without bound', () => {
    expect(parseInput({ fromUsers: ['apify'] }).maxRequests).toBe(500);
    expect(parseInput({ fromUsers: ['apify'], maxRequests: 50 }).maxRequests).toBe(50);
  });
});

describe('toFilterCriteria', () => {
  it('omits unspecified filters entirely, so absence never narrows the result set', () => {
    const criteria = toFilterCriteria(parseInput({ fromUsers: ['apify'] }));

    expect(criteria).toEqual({
      fromUsers: ['apify'],
      includeReplies: false,
      includeRetweets: false,
    });
    expect('minLikes' in criteria).toBe(false);
    expect('mediaType' in criteria).toBe(false);
  });

  it('passes through every specified filter', () => {
    const criteria = toFilterCriteria(
      parseInput({
        searchTerms: ['scraping'],
        hashtags: ['data'],
        mentioning: ['apify'],
        since: '2026-08-01',
        until: '2026-08-14',
        language: 'en',
        minLikes: 10,
        onlyVerified: true,
        mediaType: 'images',
        includeReplies: true,
      }),
    );

    expect(criteria).toMatchObject({
      searchTerms: ['scraping'],
      hashtags: ['data'],
      mentioning: ['apify'],
      since: '2026-08-01',
      until: '2026-08-14',
      language: 'en',
      minLikes: 10,
      onlyVerified: true,
      mediaType: 'images',
      includeReplies: true,
    });
  });
});

describe('topicTerms', () => {
  it('feeds both keywords and hashtags to seed discovery', () => {
    const input = parseInput({ searchTerms: ['web scraping'], hashtags: ['data'] });
    expect(topicTerms(input)).toEqual(['web scraping', '#data']);
  });
});
