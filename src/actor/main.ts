import { Actor, log } from 'apify';

import { createCountingClient } from '../adapters/http/counting.js';
import { createGotClient } from '../adapters/http/got-client.js';
import {
  createEntitlementLookup,
  readEntitlementConfig,
} from '../adapters/entitlement/apify-kv.js';
import { DirectHandleDiscovery } from '../adapters/discovery/direct.js';
import { SeededTopicDiscovery } from '../adapters/discovery/seeded-topic.js';
import type { DiscoveryStrategy } from '../adapters/discovery/types.js';
import { Crawler } from '../adapters/x/crawl.js';
import { TweetHydrator } from '../adapters/x/hydrate.js';
import { XClient } from '../adapters/x/graphql.js';
import { QueryIdResolver } from '../adapters/x/query-ids.js';
import { SessionPool, generateBrowserHeaders } from '../adapters/x/session.js';
import { collect } from '../domain/collect.js';
import { effectiveCap, requestBudgetFor, resolveEntitlement } from '../domain/entitlement.js';
import { matchesFilters, sortTweets } from '../domain/filters.js';
import { ResultSink, resumePushCount } from '../domain/result-sink.js';
import type { Tweet } from '../domain/types.js';
import { parseInput, toFilterCriteria, topicTerms } from './input.js';
import { buildRunSummary } from './summary.js';
import { loadState, persistState, type RunState } from './state.js';

/** Composition root: wiring and I/O only. Decisions live in `domain/`. */
await Actor.init();

const startedAt = Date.now();

try {
  const input = parseInput(await Actor.getInput());

  // The gate, resolved before anything is fetched.
  const entitlementConfig = readEntitlementConfig(process.env);
  const entitlement = await resolveEntitlement(
    entitlementConfig === null
      ? () => Promise.reject(new Error('entitlement store is not configured for this deployment'))
      : createEntitlementLookup({
          client: Actor.newClient(),
          actorRunId: Actor.getEnv().actorRunId ?? undefined,
          ...entitlementConfig,
        }),
  );
  const cap = effectiveCap(entitlement, input.maxResults);
  const requestBudget = requestBudgetFor(entitlement, input.maxRequests);

  if (entitlement.reason === 'entitlement_unavailable') {
    // The alertable case: same cap, but this one may be a paying customer.
    log.warning('entitlement could not be verified — capping as free', {
      reason: entitlement.reason,
      detail: entitlement.detail,
      cap,
    });
  } else {
    log.info('entitlement resolved', { paid: entitlement.paid, cap, requested: input.maxResults });
  }

  if (requestBudget < input.maxRequests) {
    // The push cap stops N matches; it cannot stop a search that never matches.
    log.info('request budget lowered for an unverified run', {
      configured: input.maxRequests,
      applied: requestBudget,
    });
  }

  // Resume: the counter is floored on an authority the runner cannot lower.
  const dataset = await Actor.openDataset();
  const datasetInfo = await dataset.getInfo();
  const state: RunState = await loadState();
  const alreadyPushed = resumePushCount(state.pushed, datasetInfo?.itemCount ?? 0);

  if (alreadyPushed > 0) {
    log.info('resuming', { alreadyPushed, datasetItems: datasetInfo?.itemCount ?? 0 });
  }

  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
  // Counting sits outermost so the queryId bundle and seed lookup count toward cost too.
  const { client: http, stats: transfer } = createCountingClient(createGotClient());

  const pool = new SessionPool({
    http,
    maxSessions: input.maxSessions,
    newProxyUrl: async (sessionId) => proxyConfiguration?.newUrl(sessionId),
    onEvent: (event) => log.debug('session', event),
  });

  const queryIds = new QueryIdResolver(http, () => ({ headers: generateBrowserHeaders() }));

  const xClient = new XClient({
    http,
    pool,
    queryIds,
    onEvent: (event) => {
      if (event.statusCode !== undefined) log.debug('x request', event);
    },
  });

  // Discovery: the only non-X call, and only when no handles were given.
  const terms = topicTerms(input);
  const discovery: DiscoveryStrategy =
    (input.fromUsers?.length ?? 0) > 0
      ? new DirectHandleDiscovery(input.fromUsers ?? [])
      : terms.length > 0
        ? new SeededTopicDiscovery({
            http,
            terms,
            proxyUrl: await proxyConfiguration?.newUrl('discovery'),
            onEvent: (event) => log.info('seed lookup', event),
          })
        : // A tweetIds-only run has nothing to discover and must not pay to find out.
          new DirectHandleDiscovery([]);

  const crawler = new Crawler({
    client: xClient,
    discovery,
    concurrency: input.maxConcurrency,
    maxAccounts: input.maxAccounts,
    // Off when the caller named the accounts: `fromUsers` filters as well as seeds, so
    // anything an expanded account produced would be discarded anyway.
    expansionDepth: (input.fromUsers?.length ?? 0) > 0 ? 0 : input.expansionDepth,
    cursors: state.cursors,
    maxPagesPerAccount: input.maxPagesPerAccount,
    maxRequests: requestBudget,
    onEvent: (event) => log.debug('crawl', event),
  });

  // Buffered and written once at the end: `sortBy` is a property of the whole result set
  // and cannot be honoured by an append-only stream. Bounded by the cap.
  const buffer: Tweet[] = [...state.buffer];
  const seen = new Set(state.seen);

  const sink = new ResultSink<Tweet>({
    cap,
    alreadyPushed,
    push: async (tweet) => {
      buffer.push(tweet);
    },
  });

  const hydrator = new TweetHydrator({
    client: xClient,
    tweetIds: input.tweetIds ?? [],
    maxRequests: requestBudget,
    onEvent: (event) => log.debug('hydrate', event),
  });

  // Ids first, then timelines. Both stay lazy, so the cap stops the fetching.
  async function* surfaces(): AsyncGenerator<Tweet> {
    yield* hydrator.tweets();
    yield* crawler.tweets();
  }

  const criteria = toFilterCriteria(input);

  // Naming a tweet by id is the selection, so an explicit id opts into replies and
  // retweets; those defaults exist to shape a timeline sweep. Other filters still apply.
  const requestedIds = new Set(input.tweetIds ?? []);
  const byIdCriteria = { ...criteria, includeReplies: true, includeRetweets: true };
  const matches = (tweet: Tweet): boolean =>
    matchesFilters(tweet, requestedIds.has(tweet.id) ? byIdCriteria : criteria);

  const snapshot = (): RunState => ({
    pushed: sink.count,
    cursors: crawler.stats.cursors,
    seen: [...seen],
    buffer,
  });

  Actor.on('migrating', () => void persistState(snapshot()));
  Actor.on('aborting', () => void persistState(snapshot()));
  const checkpoint = setInterval(() => void persistState(snapshot()), 30_000);

  let collected;
  try {
    collected = await collect(surfaces(), {
      sink,
      seen,
      matches,
      keyOf: (tweet) => tweet.id,
    });
  } finally {
    clearInterval(checkpoint);
  }

  const ordered = sortTweets(buffer, input.sortBy);
  await Actor.pushData(ordered);
  // Now in the dataset; keeping it would double-push on a resurrect.
  await persistState({ ...snapshot(), buffer: [] });

  const summary = buildRunSummary({
    requestedMaxResults: input.maxResults,
    requestBudget,
    entitlement,
    collect: collected,
    crawl: crawler.stats,
    hydrate: hydrator.stats,
    client: xClient.stats,
    transfer,
    discoveryStrategy: discovery.name,
    tokensConsumed: pool.totalCreated,
    wallClockMs: Date.now() - startedAt,
    memoryMbytes: Actor.getEnv().memoryMbytes,
  });

  await Actor.setValue('OUTPUT', summary);
  log.info('run summary', { ...summary });

  if (summary.pushed === 0) {
    log.warning(
      'no tweets matched. Recall is bounded by the seed set: keyword and hashtag runs ' +
        'return tweets from accounts that discuss the topic, not every tweet on X.',
    );
  }
} catch (err) {
  log.error('run failed', { message: (err as Error).message });
  await Actor.fail((err as Error).message);
}

await Actor.exit();
