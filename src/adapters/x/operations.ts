import type { XClient } from './graphql.js';
import { TargetUnavailableError } from './errors.js';
import { asBoolean, asString, path } from './json.js';
import { extractTimelinePage, readUnavailableReason, type TimelinePage } from './timeline.js';

/**
 * The two operations the whole Actor runs on. Of the 23 GraphQL operations probed, only
 * four are reachable with guest auth, and these are the two that carry data we need
 * (SPEC.md §2).
 */

export interface XUser {
  readonly id: string;
  readonly username: string;
  readonly name: string | null;
  readonly protected: boolean;
}

export async function fetchUserByScreenName(client: XClient, handle: string): Promise<XUser> {
  const screenName = handle.replace(/^@/, '');
  const payload = await client.call(
    'UserByScreenName',
    { screen_name: screenName, withSafetyModeUserFields: true },
    { target: screenName },
  );

  const unavailable = readUnavailableReason(payload);
  if (unavailable !== null) throw new TargetUnavailableError(screenName, unavailable);

  const result = path(payload, 'data', 'user', 'result');
  const id = asString(path(result, 'rest_id'));
  if (id === null)
    throw new TargetUnavailableError(screenName, 'not_found', 'no rest_id in response');

  return {
    id,
    // `core.screen_name` is the current path; `legacy.screen_name` is being emptied out.
    username: asString(path(result, 'core', 'screen_name')) ?? screenName,
    name: asString(path(result, 'core', 'name')),
    protected:
      asBoolean(path(result, 'privacy', 'protected')) ||
      asBoolean(path(result, 'legacy', 'protected')),
  };
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
