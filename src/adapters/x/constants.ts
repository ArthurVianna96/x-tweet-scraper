/**
 * X's **public web bearer**. This is not a credential and not a secret: it is a
 * constant embedded in x.com's own JavaScript bundle, served to every logged-out
 * visitor, and it authenticates nobody. Guest auth is carried by the short-lived
 * `x-guest-token` that we mint per session.
 *
 * Brief §3 forbids *account* credentials — cookies, passwords, session tokens. This is
 * none of those, and the Actor never sees or stores an account identity.
 */
export const PUBLIC_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const GUEST_ACTIVATE_URL = 'https://api.x.com/1.1/guest/activate.json';

export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

/**
 * The logged-out SPA. `x.com/` serves a server-rendered login wall with no app bundle,
 * so `/explore` is the reachable entry point for queryId extraction (SPEC.md §2).
 */
export const BUNDLE_PAGE = 'https://x.com/explore';

/** Operations verified reachable with guest auth. Anything else returns 404 (SPEC.md §2). */
export const GUEST_PERMITTED_OPERATIONS = [
  'UserByScreenName',
  'UserTweets',
  'TweetResultByRestId',
  'GenericTimelineById',
] as const;

export type GuestOperation = (typeof GUEST_PERMITTED_OPERATIONS)[number];
