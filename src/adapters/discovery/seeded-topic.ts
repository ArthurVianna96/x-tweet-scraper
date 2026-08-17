import type { HttpClient } from '../http/client.js';
import { generateBrowserHeaders } from '../x/session.js';
import type { DiscoveryResult, DiscoveryStrategy } from './types.js';

/**
 * Resolve a topic to candidate X accounts with one search-engine lookup per term.
 *
 * **Why an index of profiles rather than an index of posts.** The obvious version of
 * this — search the web for tweet URLs and hydrate them by ID — was implemented and
 * measured, then rejected: for a keyword query the freshest indexed tweet was 36 days
 * old (median 181), and a hashtag query returned zero tweet URLs at all. Search engines
 * index X *profiles* well and X *posts* slowly, so we ask them the question they can
 * answer — "who talks about this" — and get recency from X itself afterwards.
 *
 * The lookup runs once, at cold start, and not at all when `fromUsers` is supplied.
 */
export interface SeededTopicOptions {
  readonly http: HttpClient;
  /** Topic terms — `searchTerms` and `hashtags` from the input. */
  readonly terms: readonly string[];
  /** Cap on lookups, so a long term list cannot turn cold start into a crawl. */
  readonly maxQueries?: number;
  readonly maxHandles?: number;
  readonly proxyUrl?: string | undefined;
  readonly onEvent?: (event: { query: string; found: number; statusCode: number }) => void;
}

/**
 * Paths under x.com that are not accounts. Without this list the seed set fills up with
 * `x.com/en/developer`-style URLs, and every one of them costs a wasted `UserByScreenName`.
 */
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
      // One coherent browser identity per lookup, same reasoning as the X session
      // triples: a search engine reads header incoherence the same way X does.
      const headers = generateBrowserHeaders();

      for (const url of endpointsFor(term)) {
        requests++;
        const response = await this.opts.http({
          url,
          headers,
          proxyUrl: this.opts.proxyUrl,
        });

        const found = extractHandles(response.body);
        this.opts.onEvent?.({ query: term, found: found.length, statusCode: response.statusCode });
        for (const handle of found) handles.add(handle);

        // The lite endpoint is only tried when the HTML one returned nothing useful,
        // which keeps the common case at exactly one external request per term.
        if (found.length > 0) break;
      }
    }

    return { handles: [...handles].slice(0, this.opts.maxHandles ?? 25), requests };
  }
}

function endpointsFor(term: string): string[] {
  const query = encodeURIComponent(`site:x.com ${term}`);
  return [
    `https://html.duckduckgo.com/html/?q=${query}`,
    `https://lite.duckduckgo.com/lite/?q=${query}`,
  ];
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
