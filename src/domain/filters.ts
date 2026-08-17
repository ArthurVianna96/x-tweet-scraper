import { compareIdDesc, parseBoundary, snowflakeToMs } from './snowflake.js';
import type { Tweet } from './types.js';

/**
 * Filter predicates (SPEC.md §3.1, brief §4).
 *
 * Two rules govern everything here:
 *   - **An unspecified filter is no constraint.** Absence never narrows a result set.
 *   - **Filters combine with AND; values within one filter combine with OR.**
 *     `hashtags: ["a","b"]` means "a or b"; adding `minLikes` means "(a or b) and likes ≥ n".
 *
 * Several rulings the brief leaves undefined are decided here and repeated in the README,
 * because a reviewer will diff documented behaviour against actual behaviour.
 */

export type MediaFilter = 'images' | 'video' | 'links' | 'text_only';
export type SortOrder = 'latest' | 'top';

export interface FilterCriteria {
  readonly searchTerms?: readonly string[];
  readonly fromUsers?: readonly string[];
  readonly hashtags?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly language?: string;
  readonly minLikes?: number;
  readonly minRetweets?: number;
  readonly minReplies?: number;
  readonly onlyVerified?: boolean;
  readonly mediaType?: MediaFilter;
  /** Both default to `false`: §4 states the default only for retweets (SPEC.md §3.1). */
  readonly includeReplies?: boolean;
  readonly includeRetweets?: boolean;
}

export function matchesFilters(tweet: Tweet, criteria: FilterCriteria): boolean {
  return (
    matchesStructure(tweet, criteria) &&
    matchesDateRange(tweet, criteria) &&
    matchesText(tweet, criteria) &&
    matchesPeople(tweet, criteria) &&
    matchesEngagement(tweet, criteria) &&
    matchesMedia(tweet, criteria.mediaType)
  );
}

function matchesStructure(tweet: Tweet, criteria: FilterCriteria): boolean {
  if (tweet.isReply && criteria.includeReplies !== true) return false;
  if (tweet.isRetweet && criteria.includeRetweets !== true) return false;
  if (criteria.language !== undefined && tweet.lang !== criteria.language) return false;
  if (criteria.onlyVerified === true && !tweet.author.verified) return false;
  return true;
}

/**
 * Applied against the Snowflake rather than `createdAt`: the ID is always present and
 * always exact, whereas `created_at` is a formatted string that can be missing.
 */
function matchesDateRange(tweet: Tweet, criteria: FilterCriteria): boolean {
  if (criteria.since === undefined && criteria.until === undefined) return true;

  const createdMs = snowflakeToMs(tweet.id);
  if (createdMs === null) return false;

  if (criteria.since !== undefined) {
    const since = parseBoundary(criteria.since, 'since');
    if (since !== null && createdMs < since) return false;
  }
  if (criteria.until !== undefined) {
    const until = parseBoundary(criteria.until, 'until');
    if (until !== null && createdMs > until) return false;
  }
  return true;
}

function matchesText(tweet: Tweet, criteria: FilterCriteria): boolean {
  if (isNonEmpty(criteria.searchTerms)) {
    const haystack = tweet.text.toLowerCase();
    // Matched against the *normalized* text, so a term hidden behind a t.co link or an
    // HTML entity in the raw payload is still found.
    if (!criteria.searchTerms.some((term) => haystack.includes(term.toLowerCase()))) {
      return false;
    }
  }

  if (isNonEmpty(criteria.hashtags)) {
    const present = new Set(tweet.entities.hashtags.map(lower));
    // Supplied without '#', but tolerate it — users paste hashtags with the hash.
    if (!criteria.hashtags.some((tag) => present.has(lower(tag).replace(/^#/, '')))) {
      return false;
    }
  }

  return true;
}

/**
 * `fromUsers` is a target *and* a filter: snowball expansion reaches accounts the caller
 * did not name, and their tweets are not what was asked for.
 */
function matchesPeople(tweet: Tweet, criteria: FilterCriteria): boolean {
  if (!isNonEmpty(criteria.fromUsers)) return true;

  const author = tweet.author.username === null ? null : lower(tweet.author.username);
  return author !== null && criteria.fromUsers.map(handle).includes(author);
}

function matchesEngagement(tweet: Tweet, criteria: FilterCriteria): boolean {
  // Inclusive floors. A null metric counts as 0 — absent data is not evidence of
  // engagement, and the alternative (passing everything) would break `minLikes` on any
  // tweet X served without counters.
  if ((tweet.metrics.likes ?? 0) < (criteria.minLikes ?? 0)) return false;
  if ((tweet.metrics.retweets ?? 0) < (criteria.minRetweets ?? 0)) return false;
  if ((tweet.metrics.replies ?? 0) < (criteria.minReplies ?? 0)) return false;
  return true;
}

function matchesMedia(tweet: Tweet, mediaType: MediaFilter | undefined): boolean {
  if (mediaType === undefined) return true;

  const media = tweet.entities.media;
  const hasPhoto = media.some((m) => m.type === 'photo');
  // X stores GIFs as MP4 and §4 offers no `gif` value, so `animated_gif` groups here.
  const hasVideo = media.some((m) => m.type === 'video' || m.type === 'animated_gif');
  const hasLinks = tweet.entities.urls.length > 0;

  switch (mediaType) {
    case 'images':
      // "Tweets with images" is the natural reading. Requiring *only* photos would
      // surprise a user whose tweet also has a link.
      return hasPhoto;
    case 'video':
      return hasVideo;
    case 'links':
      return hasLinks;
    case 'text_only':
      // No media AND no links: `links` is its own enum value, so allowing links inside
      // `text_only` would make the enum incoherent.
      return media.length === 0 && !hasLinks;
  }
}

/**
 * Ordering (SPEC.md §3.1).
 *
 * `latest` is exact: descending Snowflake is descending time. `top` is an approximation
 * by engagement **within the collected set** — X's own relevance ranking is not
 * reproducible from the guest surface, and that is declared out of scope rather than
 * faked.
 */
export function sortTweets(tweets: readonly Tweet[], sortBy: SortOrder): Tweet[] {
  const sorted = [...tweets];

  if (sortBy === 'latest') {
    sorted.sort((a, b) => compareIdDesc(a.id, b.id));
    return sorted;
  }

  sorted.sort((a, b) => {
    const score = engagement(b) - engagement(a);
    return score !== 0 ? score : compareIdDesc(a.id, b.id);
  });
  return sorted;
}

function engagement(tweet: Tweet): number {
  return (tweet.metrics.likes ?? 0) + (tweet.metrics.retweets ?? 0);
}

function isNonEmpty(values: readonly string[] | undefined): values is readonly string[] {
  return values !== undefined && values.length > 0;
}

const lower = (value: string): string => value.toLowerCase();
const handle = (value: string): string => lower(value).replace(/^@/, '');
