import type {
  MediaKind,
  Tweet,
  TweetAuthor,
  TweetEntities,
  TweetMedia,
  TweetMetrics,
} from '../../domain/types.js';
import { asArray, asBoolean, asNumber, asRecord, asString, path } from './json.js';
import { unwrapVisibility } from './timeline.js';

/**
 * X payload → the §5 output contract (SPEC.md §3.2).
 *
 * Pure, so the whole thing is testable against committed fixtures with no network.
 */

export interface NormalizeOptions {
  /** Injected so output is deterministic in tests. */
  readonly now?: () => Date;
}

export function normalizeTweet(raw: unknown, opts: NormalizeOptions = {}): Tweet | null {
  const result = unwrapVisibility(raw);
  const id = asString(path(result, 'rest_id'));
  const legacy = asRecord(path(result, 'legacy'));
  if (id === null || legacy === null) return null;

  const isRetweet = path(legacy, 'retweeted_status_result', 'result') !== undefined;
  const isQuote = asBoolean(legacy['is_quote_status']);
  const inReplyToId = asString(legacy['in_reply_to_status_id_str']);

  /**
   * Step 1 of the text pipeline: pick the object the content lives on. A retweet's own
   * `legacy.full_text` is the `"RT @handle: …"` wrapper, truncated at ~140 chars; the
   * real content is one level down, and everything textual must be read from there.
   */
  const contentSource = isRetweet ? path(legacy, 'retweeted_status_result', 'result') : result;

  const author = readAuthor(result);
  const text = buildText(contentSource);
  const entities = readEntities(contentSource);

  return {
    id,
    // Built, not read: X does not ship a canonical permalink in the payload.
    url: `https://x.com/${author.username ?? 'i'}/status/${id}`,
    text,
    lang: asString(legacy['lang']),
    createdAt: parseTwitterDate(asString(legacy['created_at'])),
    conversationId: asString(legacy['conversation_id_str']),
    isReply: inReplyToId !== null,
    isRetweet,
    isQuote,
    inReplyToId,
    quotedTweetId: asString(legacy['quoted_status_id_str']),
    author,
    /**
     * Metrics come from the *original* for a retweet. The wrapper's counters are
     * structurally zero — measured: wrapper `favorite_count: 0` against the original's
     * `13` on the same retweet — so reading the wrapper would make `minLikes` silently
     * discard every retweet in the run (SPEC.md §3.2).
     */
    metrics: readMetrics(contentSource),
    entities,
    source: stripHtml(asString(path(result, 'source'))),
    scrapedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Step 2 of the text pipeline: the object the text and its entities both come from.
 *
 * Long-form posts keep their full text in `note_tweet`; `legacy.full_text` is truncated
 * at ~280 chars with a t.co pointer appended. The truncated version can therefore be
 * *longer* in raw characters than the complete one — measured 302 vs 283 on one @apify
 * post, because the appended t.co link costs 23 characters more than the ending it
 * replaced. "Whichever string is longer" emits the truncated text; the presence of
 * `note_tweet` is the rule.
 *
 * Text and entities are resolved together because they must agree: a note tweet's
 * entities live under `entity_set`, and describing one string with the other's offsets
 * is how bare `t.co` links survive into the output.
 */
function readTextSource(contentSource: unknown): { text: string; entities: unknown } {
  const note = path(contentSource, 'note_tweet', 'note_tweet_results', 'result');
  const noteText = asString(path(note, 'text'));
  if (noteText !== null) return { text: noteText, entities: path(note, 'entity_set') };

  const legacy = path(contentSource, 'legacy');
  return {
    text: asString(path(legacy, 'full_text')) ?? '',
    entities: path(legacy, 'entities'),
  };
}

/** Steps 2–4 of the text pipeline. Order is load-bearing; see the comment on decoding. */
function buildText(contentSource: unknown): string {
  const { text, entities } = readTextSource(contentSource);

  /**
   * Step 3. A tweet's trailing photo/video link is a t.co too, but it lives in
   * `entities.media[]`, not `entities.urls[]` — and always on `legacy`, since note tweets
   * carry no media set. Expanding only the urls leaves a bare `https://t.co/…` in the
   * text of every tweet that has media, the single most common case there is.
   */
  const expanded = expandUrls(text, [
    ...asArray(path(entities, 'urls')),
    ...asArray(path(contentSource, 'legacy', 'entities', 'media')),
  ]);

  /**
   * Step 4, and it must be last. X's `indices` are offsets into the *raw* string, so any
   * transform that changes length invalidates every later index — decoding `&amp;`
   * (5 chars) to `&` (1 char) shifts everything after it by four (SPEC.md §3.2).
   *
   * We sidestep index arithmetic entirely by replacing t.co tokens as strings, which is
   * also immune to a second trap: X computes indices in Unicode code points while
   * JavaScript slices in UTF-16 code units, so a single emoji earlier in a tweet
   * desynchronises them. Decoding still happens last, so the invariant holds if anyone
   * later switches to index-based replacement.
   */
  return decodeHtmlEntities(expanded);
}

/** Step 3: t.co → the real destination. */
function expandUrls(text: string, urlEntities: readonly unknown[]): string {
  let output = text;
  for (const entity of urlEntities) {
    const shortUrl = asString(path(entity, 'url'));
    const expandedUrl = asString(path(entity, 'expanded_url'));
    if (shortUrl === null || expandedUrl === null) continue;
    output = output.split(shortUrl).join(expandedUrl);
  }
  return output;
}

/** X encodes exactly these three. Anything else in a tweet is a literal. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_match, name: string) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    return '>';
  });
}

function readAuthor(result: unknown): TweetAuthor {
  const user = path(result, 'core', 'user_results', 'result');

  return {
    id: asString(path(user, 'rest_id')),
    // `core.screen_name`, not `legacy.screen_name` — X is emptying the legacy user object.
    username: asString(path(user, 'core', 'screen_name')),
    name: asString(path(user, 'core', 'name')),
    /**
     * X conflates paid Blue with legacy verification, and §5's single boolean cannot
     * distinguish them. Never key off `verified_type`: `@grok` returns
     * `verification: { verified: false, verified_type: "Business" }` while being
     * unmistakably verified in the UI via `is_blue_verified`.
     */
    verified:
      asBoolean(path(user, 'is_blue_verified')) ||
      asBoolean(path(user, 'verification', 'verified')),
    // `legacy.followers_count` no longer exists. Most published scrapers still read it
    // and silently emit null.
    followers: asNumber(path(user, 'relationship_counts', 'followers')),
    following: asNumber(path(user, 'relationship_counts', 'following')),
  };
}

function readMetrics(contentSource: unknown): TweetMetrics {
  const legacy = asRecord(path(contentSource, 'legacy'));

  return {
    likes: asNumber(path(legacy, 'favorite_count')),
    retweets: asNumber(path(legacy, 'retweet_count')),
    replies: asNumber(path(legacy, 'reply_count')),
    quotes: asNumber(path(legacy, 'quote_count')),
    bookmarks: asNumber(path(legacy, 'bookmark_count')),
    // Arrives as a string (`"8202638"`) while every sibling metric is a number.
    views: asNumber(path(contentSource, 'views', 'count')),
  };
}

function readEntities(contentSource: unknown): TweetEntities {
  const { entities } = readTextSource(contentSource);

  return {
    hashtags: asArray(path(entities, 'hashtags'))
      .map((h) => asString(path(h, 'text')))
      .filter((h): h is string => h !== null),
    mentions: asArray(path(entities, 'user_mentions'))
      .map((m) => asString(path(m, 'screen_name')))
      .filter((m): m is string => m !== null),
    urls: asArray(path(entities, 'urls'))
      .map((u) => asString(path(u, 'expanded_url')))
      .filter((u): u is string => u !== null),
    // Media only ever lives on `legacy.extended_entities`; note tweets have no media set.
    media: asArray(path(contentSource, 'legacy', 'extended_entities', 'media'))
      .map(readMedia)
      .filter((m): m is TweetMedia => m !== null),
  };
}

function readMedia(raw: unknown): TweetMedia | null {
  const type = asString(path(raw, 'type'));
  if (type !== 'photo' && type !== 'video' && type !== 'animated_gif') return null;

  const still = asString(path(raw, 'media_url_https'));

  /**
   * For video and GIFs `media_url_https` is the poster frame, not the media. Emitting it
   * as `url` would make every video item indistinguishable from a photo, so we resolve
   * the highest-bitrate MP4 variant and keep the still as the thumbnail. (X stores GIFs
   * as MP4, which is also why `animated_gif` groups under `video` for filtering —
   * SPEC.md §3.1.)
   */
  if (type === 'video' || type === 'animated_gif') {
    return { type: type as MediaKind, url: bestVideoVariant(raw) ?? still, thumbnail: still };
  }

  return { type, url: still, thumbnail: still };
}

function bestVideoVariant(raw: unknown): string | null {
  let bestUrl: string | null = null;
  let bestBitrate = -1;

  for (const variant of asArray(path(raw, 'video_info', 'variants'))) {
    if (asString(path(variant, 'content_type')) !== 'video/mp4') continue;
    const bitrate = asNumber(path(variant, 'bitrate')) ?? 0;
    const url = asString(path(variant, 'url'));
    if (url !== null && bitrate > bestBitrate) {
      bestBitrate = bitrate;
      bestUrl = url;
    }
  }

  return bestUrl;
}

/** `<a href="…">Twitter Web App</a>` → `Twitter Web App`. */
function stripHtml(value: string | null): string | null {
  if (value === null) return null;
  const text = value.replace(/<[^>]*>/g, '').trim();
  return text.length > 0 ? text : null;
}

const MONTHS: Readonly<Record<string, string>> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/**
 * `"Fri Aug 14 15:38:52 +0000 2026"` → `"2026-08-14T15:38:52.000Z"`.
 *
 * Parsed explicitly rather than handed to `new Date(string)`, whose behaviour on
 * non-ISO formats is implementation-defined — it happens to work in V8 today, which is
 * not a guarantee worth resting the `since`/`until` filters on.
 */
export function parseTwitterDate(value: string | null): string | null {
  if (value === null) return null;

  const match = /^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (\d{4})$/.exec(value);
  if (match === null) return null;

  const [, month, day, time, offset, year] = match;
  const monthNumber = month === undefined ? undefined : MONTHS[month];
  if (monthNumber === undefined) return null;

  const parsed = new Date(`${year}-${monthNumber}-${day}T${time}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
