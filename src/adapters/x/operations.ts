import type { TweetAuthor } from '../../domain/types.js';
import type { XClient } from './graphql.js';
import { TargetUnavailableError } from './errors.js';
import { asBoolean, asString, path } from './json.js';
import { readUserFields } from './normalizer.js';
import {
  extractTimelinePage,
  readUnavailableReason,
  unwrapVisibility,
  type TimelinePage,
} from './timeline.js';

/**
 * The three guest-reachable surfaces the Actor is built on (brief §2a): tweets by author,
 * a profile by handle, and a single tweet by id. Of the 23 GraphQL operations probed,
 * five are reachable with guest auth and these carry all the data we need.
 * `npm run probe` re-derives that matrix; `docs/README-data-source.md` §2 records it.
 */

/**
 * A profile, in exactly §5's `author` shape plus what the crawl needs to page it.
 *
 * `id` and `username` narrow their `TweetAuthor` counterparts to non-null: the call
 * throws without an id, and `username` falls back to the handle we asked for.
 */
export interface XProfile extends TweetAuthor {
  readonly id: string;
  readonly username: string;
  /** Not a §5 field. A protected account is readable as a profile but not as a timeline. */
  readonly protected: boolean;
}

/** The profile surface (brief §2a): handle → the §5 `author` block. */
export async function fetchUserProfile(client: XClient, handle: string): Promise<XProfile> {
  const screenName = handle.replace(/^@/, '');
  const payload = await client.call(
    'UserByScreenName',
    { screen_name: screenName, withSafetyModeUserFields: true },
    { target: screenName },
  );

  const unavailable = readUnavailableReason(payload);
  if (unavailable !== null) throw new TargetUnavailableError(screenName, unavailable);

  const result = path(payload, 'data', 'user', 'result');
  const author = readUserFields(result);
  if (author.id === null)
    throw new TargetUnavailableError(screenName, 'not_found', 'no rest_id in response');

  return {
    ...author,
    id: author.id,
    username: author.username ?? screenName,
    protected:
      asBoolean(path(result, 'privacy', 'protected')) ||
      asBoolean(path(result, 'legacy', 'protected')),
  };
}

/**
 * The by-id surface (brief §2a): one tweet, fully hydrated.
 *
 * The result sits at `data.tweetResult.result` and is the same object a timeline entry
 * carries, so `normalizeTweet` reads it unchanged — including the retweet and note_tweet
 * paths. Returns `null` when X has no such tweet (deleted, or an id that never existed),
 * because one dead id must not fail a run of many.
 */
export async function fetchTweetById(client: XClient, tweetId: string): Promise<unknown | null> {
  const payload = await client.call(
    'TweetResultByRestId',
    {
      tweetId,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
    },
    { target: tweetId },
  );

  const result = path(payload, 'data', 'tweetResult', 'result');
  // An unknown id returns `tweetResult: {}` rather than an error.
  return result === undefined ? null : unwrapVisibility(result);
}

/**
 * `count: 100` is silently ignored — X serves ~20 tweets per page regardless, which is
 * the cost unit the whole concurrency design is built on (SPEC.md §6). We ask for 20 so
 * the request describes what it actually gets.
 */
export const USER_TWEETS_PAGE_SIZE = 20;

export async function fetchUserTweetsPage(
  client: XClient,
  args: { userId: string; handle: string; cursor?: string | null },
): Promise<TimelinePage> {
  const variables: Record<string, unknown> = {
    userId: args.userId,
    count: USER_TWEETS_PAGE_SIZE,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: true,
  };
  if (args.cursor !== undefined && args.cursor !== null) variables['cursor'] = args.cursor;

  const payload = await client.call('UserTweets', variables, { target: args.handle });

  const unavailable = readUnavailableReason(payload);
  if (unavailable !== null) throw new TargetUnavailableError(args.handle, unavailable);

  return extractTimelinePage(payload);
}

export interface PageInfo {
  readonly cursor: string | null;
  readonly count: number;
  readonly fresh: number;
  readonly terminated: boolean;
}

/**
 * Lazily pages one account's timeline. Nothing is fetched until the consumer pulls, so
 * the free-tier cap stops the *crawl*, not just the output (SPEC.md §4.3).
 *
 * The stop conditions are structural rather than declarative, because X's own
 * `TimelineTerminateTimeline` instruction is unreliable here — see
 * `timeline.ts#isBottomTerminated` for the measurement. We stop when the data says we
 * are done: no cursor, an empty page, a cursor that did not advance, or a page that
 * contained nothing we had not already seen.
 */
export async function* streamUserTweets(
  client: XClient,
  args: { userId: string; handle: string; startCursor?: string | null; maxPages?: number },
  onPage?: (info: PageInfo) => void,
): AsyncGenerator<unknown> {
  let cursor = args.startCursor ?? null;
  const maxPages = args.maxPages ?? Number.POSITIVE_INFINITY;
  const seenOnThisAccount = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const result = await fetchUserTweetsPage(client, {
      userId: args.userId,
      handle: args.handle,
      cursor,
    });

    const fresh = result.results.filter((tweet) => {
      const id = asString(path(tweet, 'rest_id'));
      return id === null || !seenOnThisAccount.has(id);
    });

    /**
     * Reported *before* yielding, because a page that was fetched has been paid for even
     * if the consumer stops halfway through it. Reporting after the loop undercounts
     * every run that ends at the free-tier cap — which is every free run.
     */
    onPage?.({
      cursor: result.nextCursor,
      count: result.results.length,
      fresh: fresh.length,
      terminated: result.terminated,
    });

    for (const tweet of fresh) {
      const id = asString(path(tweet, 'rest_id'));
      if (id !== null) seenOnThisAccount.add(id);
      yield tweet;
    }

    if (result.nextCursor === null || result.nextCursor === cursor) return;
    if (result.results.length === 0) return;
    // A full page we have already seen means the cursor is cycling, not advancing.
    if (fresh.length === 0) return;

    cursor = result.nextCursor;
  }
}
