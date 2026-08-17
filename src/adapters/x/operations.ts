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
 * The three surfaces X leaves open to a guest token: an author's tweets, a profile by
 * handle, and one tweet by id. `npm run probe` re-derives which operations are reachable.
 */

/** `id` and `username` are non-null here: the call throws without an id. */
export interface XProfile extends TweetAuthor {
  readonly id: string;
  readonly username: string;
  /** A protected account is readable as a profile but not as a timeline. */
  readonly protected: boolean;
}
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
 * The result is the same object a timeline entry carries, so `normalizeTweet` reads it
 * unchanged. `null` when X has no such tweet, so one dead id cannot fail a run of many.
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

/** X ignores anything larger and serves ~20 per page regardless. */
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
 * Lazy: nothing is fetched until the consumer pulls, so the cap stops the crawl and not
 * merely its output. Stops on structural signals rather than on X's own terminate
 * instruction, which `isBottomTerminated` explains.
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

    // Reported before yielding: a fetched page is paid for even if the consumer stops
    // partway through it, which is what every capped run does.
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
    // A page of nothing new means the cursor is cycling rather than advancing.
    if (fresh.length === 0) return;

    cursor = result.nextCursor;
  }
}
