# Design contract

The invariants a change must not break, and the field-by-field mapping from X's payloads
to our output. The _why_ behind the design lives in [`README.md`](README.md); the measured
evidence lives in [`docs/README-data-source.md`](docs/README-data-source.md). This file is
the part you check before editing.

---

## Hard constraints

- No browser engine. HTTP client only.
- Native Apify Actor: input schema, SDK v3, dataset output, proxy configuration honoured.
- TypeScript strict; no `any` crossing a public boundary.
- Guest tokens only. No account credentials, no personal session.
- A single `429` or `403` must not fail a run.

## Layering

`actor → adapters → domain`, one way. `domain/` imports nothing from the other two; when
it needs an effect it takes it as a constructor argument. Every seam is constructor
injection, so the suite runs offline with no module mocking.

---

## Surfaces

Three X operations are reachable with a guest token, and the Actor is built on exactly
those. `npm run probe` re-derives the matrix.

| Surface        | Operation             | Input       |
| -------------- | --------------------- | ----------- |
| Author's posts | `UserTweets`          | `fromUsers` |
| One tweet      | `TweetResultByRestId` | `tweetIds`  |
| One profile    | `UserByScreenName`    | `fromUsers` |

Free-text search is not reachable: `SearchTimeline` returns `404` to a guest token.
`searchTerms` is served by seeding account discovery from a public web index and filtering
natively — a bonus surface with seed-bounded recall, behind the `DiscoveryStrategy` port.

---

## Input

Validated with zod at the boundary. Malformed input fails the run with a readable message.

**A run needs a target: at least one of `fromUsers`, `tweetIds`, `searchTerms`.**
`hashtags` is a post-filter over what a target produced, never a target itself.

Unspecified filter = no constraint. Filters combine with AND; values inside one filter
combine with OR.

Rulings the brief leaves open:

| Case                            | Decision                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `mediaType: images`             | ≥1 photo; other content allowed                                              |
| `mediaType: text_only`          | no media **and** no links                                                    |
| `animated_gif`                  | grouped under `video` — X stores GIFs as MP4 and the enum has no `gif` value |
| `onlyVerified`                  | `is_blue_verified \|\| verification.verified`; never `verified_type`         |
| `includeReplies`                | defaults `false`, as retweets do                                             |
| `sortBy: latest`                | descending Snowflake, which is descending time                               |
| `sortBy: top`                   | descending `likes + retweets` within the collected set                       |
| `since` / `until`               | inclusive; a bare date covers the whole day                                  |
| Missing metric vs `minLikes`    | counts as 0                                                                  |
| `tweetIds` vs structure filters | an explicit id opts into replies and retweets                                |

`maxResults` must never carry a `"maximum"` in the input schema. A limit expressed in the
input is not protection, and it would break paying users.

---

## Output

Every item conforms exactly. Absent values are `null`, never omitted and never
`undefined`. Timestamps are ISO-8601 UTC, counts are integers, ids are strings.

For a retweet, `id` / `url` / `author` / `createdAt` are the **retweet's own**, while
`text`, `metrics` and `entities` come from the **original** — the wrapper's counters are
structurally zero and would make `minLikes` discard every retweet.

| Field               | Source                                                 | Note                                                      |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `id`                | `result.rest_id`                                       | string, never a JS number                                 |
| `url`               | `x.com/<username>/status/<id>`                         | built, not read                                           |
| `text`              | see pipeline below                                     |                                                           |
| `lang`              | `legacy.lang`                                          |                                                           |
| `createdAt`         | `legacy.created_at`                                    | parsed explicitly, not via `new Date`                     |
| `conversationId`    | `legacy.conversation_id_str`                           |                                                           |
| `isReply`           | `in_reply_to_status_id_str != null`                    |                                                           |
| `isRetweet`         | `'retweeted_status_result' in legacy`                  |                                                           |
| `isQuote`           | `legacy.is_quote_status`                               |                                                           |
| `inReplyToId`       | `legacy.in_reply_to_status_id_str`                     |                                                           |
| `quotedTweetId`     | `legacy.quoted_status_id_str`                          |                                                           |
| `author.id`         | `core.user_results.result.rest_id`                     |                                                           |
| `author.username`   | `…result.core.screen_name`                             | **not** `legacy.screen_name`                              |
| `author.name`       | `…result.core.name`                                    |                                                           |
| `author.verified`   | `is_blue_verified \|\| verification.verified`          |                                                           |
| `author.followers`  | `…result.relationship_counts.followers`                | `legacy.followers_count` no longer exists                 |
| `author.following`  | `…result.relationship_counts.following`                |                                                           |
| `metrics.*`         | `legacy.{favorite,retweet,reply,quote,bookmark}_count` |                                                           |
| `metrics.views`     | `result.views.count`                                   | arrives as a string; coerce                               |
| `entities.hashtags` | `entities.hashtags[].text`                             | without `#`                                               |
| `entities.mentions` | `entities.user_mentions[].screen_name`                 | without `@`                                               |
| `entities.urls`     | `entities.urls[].expanded_url`                         | expanded, never `t.co`                                    |
| `entities.media`    | `legacy.extended_entities.media[]`                     | video `url` is the best MP4 variant, not the poster frame |
| `source`            | `result.source`, HTML stripped                         |                                                           |
| `scrapedAt`         | now, ISO                                               |                                                           |

### The text pipeline — the order is load-bearing

```
1. SELECT SOURCE OBJECT   isRetweet ? legacy.retweeted_status_result.result : self
2. SELECT TEXT FIELD      note_tweet…result.text  ??  legacy.full_text
3. EXPAND t.co            entities[].expanded_url — urls *and* media
4. DECODE HTML ENTITIES   &amp; &lt; &gt;                           ← must be last
```

Entities must come from whichever object supplied the text: a note tweet's live under
`entity_set`, not `legacy.entities`. Media t.co links live in `entities.media[]` rather
than `entities.urls[]`, and expanding only the latter leaves bare links in the output.

Decoding is last because X's `indices` are offsets into the raw string. We replace t.co
tokens as strings rather than by index, which also avoids X counting in Unicode code
points while JavaScript slices in UTF-16 units.

### Extraction — by path, never by type

```
data.user.result.timeline.timeline.instructions[]
  └─ "TimelineAddEntries" → entries[]
       ├─ "TimelineTimelineItem"   → content.itemContent.tweet_results.result
       ├─ "TimelineTimelineModule" → content.items[].item.itemContent.tweet_results.result
       └─ "TimelineTimelineCursor" → cursorType "Bottom" → next page
```

Read `tweet_results.result` at exactly that depth and never recurse into it: nested
`retweeted_status_result` and `quoted_status_result` are context, not results, and
recursion emits the same content two and three times.

Skip `TimelinePinEntry` — a pinned tweet is an arbitrarily old tweet served at the top,
and emitting it corrupts `sortBy: latest`.

**Do not obey `TimelineTerminateTimeline`.** X emits it on every page of a paginated
timeline while the bottom cursor keeps returning fresh tweets; obeying it silently costs
most of the recall. Stop on structural signals instead: no bottom cursor, a cursor that
did not advance, an empty page, or a page with nothing new.

---

## The free-tier gate

Five invariants. Breaking any one of them defeats the whole thing.

1. **Identity comes from the credential**, resolved by asking the platform whose token
   this is — never from an environment variable the runner controls.
2. **The verdict comes from a store only we can write.** It is public-read because inside
   a run the token belongs to the runner, so a private store would be unreachable. Keys
   are HMAC'd, so a world-readable store names nobody. The HMAC key must be a Secret env
   var, since a published Actor shows its non-secret ones.
3. **The cap is enforced at one lazy chokepoint**, at push time. Clamping `maxResults` on
   input is an optimisation, not the protection. Because the sink reports "stop", the cap
   stops the fetching too.
4. **Fail closed on every path** — a throw, a missing record, a malformed record, a `paid`
   field that is a string. `=== true`, never `!== false`.
5. **The resume counter is floored on `dataset.itemCount`**, which the runner cannot lower
   without deleting the results they were accumulating. Persisted state is fine for
   cursors and unacceptable for the counter that enforces the cap.

The cap alone does not bound cost: a selective filter can exhaust the account frontier
without ever reaching the cap, so an unverified run also gets a request allowance
proportional to what it may return.

Two limit reasons, because they mean different things: `free_tier` is expected, and
`entitlement_unavailable` may be capping a paying customer and is logged as a warning.

---

## Resilience

- **The session triple** — one guest token, one proxy IP, one header set — is created and
  retired together. Abuse detection looks for coherence.
- **Rotate on `429`, never sleep.** Tokens are free and instant; the rate-limit window
  belongs to the token. Triples retire before the limit, so the `429` is never taken.
- **One queryId refresh per run.** A `404` means either a stale queryId after an X deploy
  or a gated operation; refresh once, then treat it as gated.
- **Cold start is inside the retry loop.** Minting a token and fetching the queryId bundle
  are ordinary HTTP and fail the same ways.
- **A dead target never fails a run.** Protected, suspended, deleted accounts and unknown
  tweet ids are counted and skipped.
- **Resume** from persisted cursors and seen-set on migration or resurrect.

---

## Tests

Offline and deterministic, against committed fixtures. No network, no platform, no module
mocking. Required coverage:

- **The cap**: a free user requesting 1000 results gets exactly 10, and the crawl stops
  rather than the output being truncated.
- Concurrent pushes cannot overshoot the cap.
- Filter logic, including each `mediaType` ruling and the inclusive date bounds.
- The normalizer against real payloads: retweets, quotes, long-form, media, links, replies.
- The input schema agrees with the zod schema, and `maxResults` carries no maximum.

Fixtures are curated for specific edge cases. Re-capturing them can replace those cases,
which will surface as test failures rather than silence.

---

## Out of scope, stated plainly

- `sortBy: top` approximates by engagement within the collected set; X's ranking is not
  reachable as a guest.
- `searchTerms` recall is seed-bounded, and no engineering closes that from the guest
  surface.
- Live contract testing against X is not automated, so a response-shape change will not
  break the offline suite.
- A finish webhook is not implemented.
