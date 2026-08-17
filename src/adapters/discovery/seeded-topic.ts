import type { HttpClient } from '../http/client.js';
import { generateBrowserHeaders } from '../x/session.js';
import type { DiscoveryResult, DiscoveryStrategy } from './types.js';

/**
 * A topic to candidate accounts, one search-engine lookup per term, once at cold start
 * and not at all when `fromUsers` is supplied.
 *
 * It asks about profiles rather than posts because search engines index X profiles well
 * and X posts slowly; recency then comes from X itself.
 */
export interface SeededTopicOptions {
  readonly http: HttpClient;
  /** Topic terms — `searchTerms` and `hashtags` from the input. */
  readonly terms: readonly string[];
  /** So a long term list cannot turn cold start into a crawl. */
  readonly maxQueries?: number;
  readonly maxHandles?: number;
  readonly proxyUrl?: string | undefined;
  readonly onEvent?: (event: {
    query: string;
    engine: string;
    found: number;
    statusCode: number;
  }) => void;
}

/**
 * A cascade, not a dependency: engines block automated traffic unevenly and at different
 * times, so a blocked one falls through to the next. Ordered by response size, since this
 * traffic crosses the same paid proxy. The first engine that yields handles wins.
 */
const ENGINES: ReadonlyArray<{ name: string; url: (query: string) => string }> = [
  { name: 'ddg-html', url: (q) => `https://html.duckduckgo.com/html/?q=${q}` },
  { name: 'ddg-lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${q}` },
  { name: 'brave', url: (q) => `https://search.brave.com/search?q=${q}` },
  { name: 'startpage', url: (q) => `https://www.startpage.com/sp/search?query=${q}` },
];

/** Paths under x.com that are not accounts; each would cost a wasted profile lookup. */
const RESERVED_PATHS = new Set([
  'about',
  'account',
  'compose',
  'developer',
  'download',
  'en',
  'explore',
  'flow',
  'following',
  'followers',
  'hashtag',
  'help',
  'home',
  'i',
  'intent',
  'jobs',
  'l',
  'login',
  'logout',
  'messages',
  'notifications',
  'overview',
  'privacy',
  'search',
  'session',
  'settings',
  'share',
  'signup',
  'status',
  'terms',
  'tos',
  'tweet',
  'welcome',
  'who_to_follow',
  'widgets',
]);

const HANDLE_PATTERN = /(?:x|twitter)\.com(?:%2F|\/)([A-Za-z0-9_]{2,15})(?![A-Za-z0-9_])/g;

export class SeededTopicDiscovery implements DiscoveryStrategy {
  readonly name = 'seeded-topic';

  constructor(private readonly opts: SeededTopicOptions) {}

  async discover(): Promise<DiscoveryResult> {
    const queries = this.opts.terms
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .slice(0, this.opts.maxQueries ?? 3);

    const handles = new Set<string>();
    let requests = 0;

    for (const term of queries) {
      // One coherent browser identity per lookup, as with the X session triples.
      const headers = generateBrowserHeaders();
      const query = encodeURIComponent(`site:x.com ${term}`);

      for (const engine of ENGINES) {
        requests++;

        let found: string[] = [];
        let statusCode = 0;
        try {
          const response = await this.opts.http({
            url: engine.url(query),
            headers,
            proxyUrl: this.opts.proxyUrl,
          });
          statusCode = response.statusCode;
          // Anything but a 200 is a challenge, a block or an error.
          found = statusCode === 200 ? extractHandles(response.body) : [];
        } catch {
          // A dead engine is not a dead run.
          found = [];
        }

        this.opts.onEvent?.({ query: term, engine: engine.name, found: found.length, statusCode });
        for (const handle of found) handles.add(handle);

        // The first engine that answers wins; the rest are never called.
        if (found.length > 0) break;
      }
    }

    return { handles: [...handles].slice(0, this.opts.maxHandles ?? 25), requests };
  }
}

export function extractHandles(html: string): string[] {
  const handles = new Set<string>();

  for (const match of html.matchAll(HANDLE_PATTERN)) {
    const handle = match[1];
    if (handle === undefined) continue;
    if (RESERVED_PATHS.has(handle.toLowerCase())) continue;
    handles.add(handle);
  }

  return [...handles];
}
