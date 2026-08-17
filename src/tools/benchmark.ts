/**
 * Reproduces the performance numbers reported in the README (brief §8).
 *
 *   npx tsx src/tools/benchmark.ts native   apify,naval,paulg,dhh,levelsio
 *   npx tsx src/tools/benchmark.ts seeded   "ai agents"
 *
 * **Protocol**, kept from §8 even though the query is substituted:
 *   - the timer starts at the first outbound request of the measured phase;
 *   - it stops at the 100th schema-conforming item;
 *   - cold start is excluded — queryId resolution and the first guest token are warmed
 *     up before the clock starts, because they are once-per-run costs;
 *   - the run must stay clean: any 429 invalidates the measurement.
 *
 * §8's own benchmark query ("a broad keyword, sortBy latest") requires `SearchTimeline`,
 * which is gated for guest tokens — see the README. The substitution is declared rather
 * than hidden, and the diagnostics below are published so the numbers can be re-derived.
 *
 * This harness constructs its own `ResultSink` with an explicit cap. It is a standalone
 * script that never touches the Actor and cannot influence a run: the entitlement gate
 * lives in `actor/main.ts` and is exercised by `domain/free-tier.test.ts`.
 */
import { createCountingClient } from '../adapters/http/counting.js';
import { createGotClient } from '../adapters/http/got-client.js';
import { DirectHandleDiscovery } from '../adapters/discovery/direct.js';
import { SeededTopicDiscovery } from '../adapters/discovery/seeded-topic.js';
import type { DiscoveryStrategy } from '../adapters/discovery/types.js';
import { Crawler } from '../adapters/x/crawl.js';
import { XClient } from '../adapters/x/graphql.js';
import { QueryIdResolver } from '../adapters/x/query-ids.js';
import { SessionPool, generateBrowserHeaders } from '../adapters/x/session.js';
import { collect } from '../domain/collect.js';
import { matchesFilters, type FilterCriteria } from '../domain/filters.js';
import { ResultSink } from '../domain/result-sink.js';
import type { Tweet } from '../domain/types.js';

const TARGET_ITEMS = 100;

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'native';
  const argument = process.argv[3] ?? 'apify,naval,paulg,dhh,levelsio';

  const { client: http, stats: transfer } = createCountingClient(createGotClient());
  const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 5 });
  const queryIds = new QueryIdResolver(http, () => ({ headers: generateBrowserHeaders() }));
  const xClient = new XClient({ http, pool, queryIds });

  // --- cold start, excluded from the measurement ---------------------------------
  const coldStart = Date.now();
  await queryIds.get('UserTweets');
  await pool.acquire();
  const coldStartMs = Date.now() - coldStart;

  let criteria: FilterCriteria = { includeReplies: false, includeRetweets: false };
  let discovery: DiscoveryStrategy;

  if (mode === 'seeded') {
    // The keyword is applied as a filter as well as a seed, because that is what §8's
    // benchmark actually asks for: a keyword query, not a crawl of related accounts.
    discovery = new SeededTopicDiscovery({ http, terms: [argument] });
    criteria = { ...criteria, searchTerms: [argument] };
  } else {
    discovery = new DirectHandleDiscovery(argument.split(','));
  }

  const crawler = new Crawler({
    client: xClient,
    discovery,
    concurrency: 5,
    maxAccounts: 25,
    expansionDepth: mode === 'seeded' ? 1 : 0,
    maxRequests: 500,
  });

  const buffer: Tweet[] = [];
  const sink = new ResultSink<Tweet>({
    cap: TARGET_ITEMS,
    push: async (tweet) => {
      buffer.push(tweet);
    },
  });

  const baselineRequests = transfer.requests;
  const baselineBytes = transfer.bytes;

  const started = Date.now();
  const stats = await collect(crawler.tweets(), {
    sink,
    matches: (tweet) => matchesFilters(tweet, criteria),
    keyOf: (tweet) => tweet.id,
  });
  const wallClockMs = Date.now() - started;

  const requests = transfer.requests - baselineRequests;
  const bytes = transfer.bytes - baselineBytes;

  process.stdout.write(
    `${JSON.stringify(
      {
        mode,
        argument,
        coldStartMs,
        wallClockMs,
        items: stats.pushed,
        msPerItem: stats.pushed === 0 ? null : Math.round(wallClockMs / stats.pushed),
        requests,
        pagesFetched: crawler.stats.pagesFetched,
        tweetsFetched: stats.fetched,
        filteredOut: stats.filteredOut,
        selectivity: stats.fetched === 0 ? 0 : Number((stats.pushed / stats.fetched).toFixed(4)),
        duplicatesDropped: stats.duplicatesDropped,
        seedsResolved: crawler.stats.seedsResolved,
        accountsCrawled: crawler.stats.accountsCrawled,
        accountsSkipped: crawler.stats.accountsSkipped,
        budgetExhausted: crawler.stats.budgetExhausted,
        tokensConsumed: pool.totalCreated,
        megabytes: Number((bytes / 1_000_000).toFixed(1)),
        errors: xClient.stats.errors,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
