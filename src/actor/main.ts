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

/**
 * Composition root. Everything here is wiring and I/O; the decisions live in `domain/`
 * and the protocol knowledge lives in `adapters/`.
 */
await Actor.init();

const startedAt = Date.now();

try {
  const input = parseInput(await Actor.getInput());

  // --- The gate, resolved before anything is fetched (SPEC.md §4) ----------------
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
    // The alertable condition: same cap as a free user, but this one might be a paying
    // customer being capped by our own outage (SPEC.md §4.6).
    log.warning('entitlement could not be verified — capping as free', {
      reason: entitlement.reason,
      detail: entitlement.detail,
      cap,
    });
  } else {
    log.info('entitlement resolved', { paid: entitlement.paid, cap, requested: input.maxResults });
  }

  if (requestBudget < input.maxRequests) {
    // The push cap stops the run at N matches; it cannot stop a search that never
    // matches. An unverified run is bounded on both axes (SPEC.md §4.3).
    log.info('request budget lowered for an unverified run', {
      configured: input.maxRequests,
      applied: requestBudget,
    });
  }

  // --- Resume: the counter is floored on an authority the runner cannot lower ----
  const dataset = await Actor.openDataset();
  const datasetInfo = await dataset.getInfo();
  const state: RunState = await loadState();
  const alreadyPushed = resumePushCount(state.pushed, datasetInfo?.itemCount ?? 0);

  if (alreadyPushed > 0) {
    log.info('resuming', { alreadyPushed, datasetItems: datasetInfo?.itemCount ?? 0 });
  }

  // --- HTTP stack ---------------------------------------------------------------
  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
  // Counting sits outermost so the queryId bundle and the seed lookup count toward proxy
  // cost too — they travel through the same proxy and are not free.
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

  // --- Discovery: the only non-X call, and only when we have no handles ----------
  const discovery: DiscoveryStrategy =
    (input.fromUsers?.length ?? 0) > 0
      ? new DirectHandleDiscovery(input.fromUsers ?? [])
      : new SeededTopicDiscovery({
          http,
          terms: topicTerms(input),
          proxyUrl: await proxyConfiguration?.newUrl('discovery'),
          onEvent: (event) => log.info('seed lookup', event),
        });

  const crawler = new Crawler({
    client: xClient,
    discovery,
    concurrency: input.maxConcurrency,
    maxAccounts: input.maxAccounts,
    /**
     * Snowball expansion is switched off when the caller named the accounts, because
     * `fromUsers` is a filter as well as a seed: every tweet an expanded account produced
     * would be discarded by that filter, so the expansion would be pure request cost.
     */
    expansionDepth: (input.fromUsers?.length ?? 0) > 0 ? 0 : input.expansionDepth,
    cursors: state.cursors,
    maxPagesPerAccount: input.maxPagesPerAccount,
    maxRequests: requestBudget,
    onEvent: (event) => log.debug('crawl', event),
  });

  /**
   * Results are buffered and written once, at the end, because `sortBy` is a property of
   * the whole result set and cannot be honoured by an append-only stream. The buffer is
   * bounded by the cap, and it is persisted on migration so a restarted run does not
   * re-fetch what it already collected.
   */
  const buffer: Tweet[] = [...state.buffer];
  const seen = new Set(state.seen);

  const sink = new ResultSink<Tweet>({
    cap,
    alreadyPushed,
    push: async (tweet) => {
      buffer.push(tweet);
    },
  });

  const criteria = toFilterCriteria(input);
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
    collected = await collect(crawler.tweets(), {
      sink,
      seen,
      matches: (tweet) => matchesFilters(tweet, criteria),
      keyOf: (tweet) => tweet.id,
    });
  } finally {
    clearInterval(checkpoint);
  }

  const ordered = sortTweets(buffer, input.sortBy);
  await Actor.pushData(ordered);
  // The buffer is now in the dataset; keeping it would double-push on a resurrect.
  await persistState({ ...snapshot(), buffer: [] });

  const summary = buildRunSummary({
    requestedMaxResults: input.maxResults,
    requestBudget,
    entitlement,
    collect: collected,
    crawl: crawler.stats,
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
