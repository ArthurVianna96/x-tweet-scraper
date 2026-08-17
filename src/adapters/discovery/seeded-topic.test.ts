import { describe, expect, it } from 'vitest';

import type { HttpClient } from '../http/client.js';
import { DirectHandleDiscovery } from './direct.js';
import { SeededTopicDiscovery, extractHandles } from './seeded-topic.js';

const html = (paths: string[]): string =>
  paths.map((path) => `<a href="https://x.com/${path}">link</a>`).join('\n');

describe('extractHandles', () => {
  it('pulls handles out of x.com and twitter.com links, including encoded ones', () => {
    const page = `${html(['apify', 'naval/status/123'])} <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftwitter.com%2Fpaulg">x</a>`;

    expect(extractHandles(page).sort()).toEqual(['apify', 'naval', 'paulg']);
  });

  it('drops reserved paths that are not accounts', () => {
    // Without this every `x.com/en/developer`-style URL costs a wasted UserByScreenName.
    expect(extractHandles(html(['en', 'i/flow/login', 'search', 'hashtag/data', 'apify']))).toEqual(
      ['apify'],
    );
  });

  it('ignores handles longer than X allows', () => {
    expect(extractHandles(html(['thishandleiswaytoolongforx']))).toEqual([]);
  });
});

describe('SeededTopicDiscovery', () => {
  it('stops at the first engine that answers', async () => {
    const called: string[] = [];
    const http: HttpClient = async (req) => {
      called.push(new URL(req.url).host);
      return { statusCode: 200, body: html(['apify', 'naval']), headers: {} };
    };

    const result = await new SeededTopicDiscovery({ http, terms: ['scraping'] }).discover();

    expect(result.handles).toEqual(['apify', 'naval']);
    expect(called).toHaveLength(1);
    expect(result.requests).toBe(1);
  });

  it('falls through to the next engine on an anti-bot challenge', async () => {
    // Measured: DuckDuckGo answers 202 with a 14 KB challenge page once it decides an IP
    // is automated, while another engine answers 200 on the same query in the same minute.
    const called: string[] = [];
    const http: HttpClient = async (req) => {
      const host = new URL(req.url).host;
      called.push(host);
      if (host.includes('duckduckgo')) return { statusCode: 202, body: 'challenge', headers: {} };
      return { statusCode: 200, body: html(['apify']), headers: {} };
    };

    const result = await new SeededTopicDiscovery({ http, terms: ['scraping'] }).discover();

    expect(result.handles).toEqual(['apify']);
    expect(called.length).toBeGreaterThan(1);
  });

  it('survives an engine that throws', async () => {
    const http: HttpClient = async (req) => {
      if (req.url.includes('duckduckgo')) throw new Error('ECONNRESET');
      return { statusCode: 200, body: html(['apify']), headers: {} };
    };

    await expect(
      new SeededTopicDiscovery({ http, terms: ['scraping'] }).discover(),
    ).resolves.toMatchObject({ handles: ['apify'] });
  });

  it('returns nothing rather than failing when every engine is blocked', async () => {
    const http: HttpClient = async () => ({ statusCode: 403, body: '', headers: {} });

    const result = await new SeededTopicDiscovery({ http, terms: ['scraping'] }).discover();

    expect(result.handles).toEqual([]);
    expect(result.requests).toBeGreaterThan(0);
  });

  it('caps the number of lookups so cold start cannot become a crawl', async () => {
    let calls = 0;
    const http: HttpClient = async () => {
      calls++;
      return { statusCode: 200, body: html(['apify']), headers: {} };
    };

    await new SeededTopicDiscovery({
      http,
      terms: ['a', 'b', 'c', 'd', 'e'],
      maxQueries: 2,
    }).discover();

    expect(calls).toBe(2);
  });
});

describe('DirectHandleDiscovery', () => {
  it('makes no external call at all', async () => {
    const result = await new DirectHandleDiscovery(['@apify', 'naval', 'apify', '  ']).discover();

    expect(result).toEqual({ handles: ['apify', 'naval'], requests: 0 });
  });
});
