# x-tweet-scraper

A browserless X (Twitter) scraper, shipped as an Apify Actor. No browser engine, no
account credentials, no purchased tweet data — plain HTTP against X's own GraphQL API
with guest tokens, plus a free-tier cap that cannot be lifted by editing the input.

```bash
npm install
npm test                     # 154 tests, offline, ~0.4s
npm run probe                # reproduce the endpoint capability matrix (~20s, no credentials)
npm run start:dev            # run the Actor locally
```

---

## Contents

1. [The finding everything rests on](#1-the-finding-everything-rests-on)
2. [Architecture and data flow](#2-architecture-and-data-flow)
3. [The browserless approach](#3-the-browserless-approach)
4. [Free-tier protection](#4-free-tier-protection)
5. [Measured performance](#5-measured-performance)
6. [Output contract and the rulings behind it](#6-output-contract-and-the-rulings-behind-it)
7. [Running it](#7-running-it)
8. [ToS, robots.txt, and what we would raise with a client](#8-tos-robotstxt-and-what-we-would-raise-with-a-client)
9. [Known limitations and what is out of scope](#9-known-limitations-and-what-is-out-of-scope)
10. [Decisions and trade-offs](#10-decisions-and-trade-offs)

---

## 1. The finding everything rests on

**X gates its search endpoint for guest tokens.** `SearchTimeline` returns `404` with a
zero-length body — from every host, method and product variant we tried. Guest tokens
themselves are fine; the gate is on the _operation_.

`scripts/probe-x-endpoints.mjs` reproduces this in about 20 seconds with no credentials.
Its method rests on a status-code split that separates _refusal_ from _bad request_:

| Status                          | Meaning                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `404`, zero-length body         | operation **gated** — refused before validation                        |
| `422 GRAPHQL_VALIDATION_FAILED` | operation **permitted** — reached validation, our variables were wrong |
| `200`                           | operation **permitted**                                                |

Latest run (2026-08-17), **5 of 23 probed operations** are available to guests:

| Operation                                                                                                                                                                          | Guest access | Role here                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `UserByScreenName`                                                                                                                                                                 | ✅           | handle → `userId`                                                    |
| `UserTweets`                                                                                                                                                                       | ✅           | **the extraction engine** — complete tweet objects + cursors         |
| `TweetResultByRestId`                                                                                                                                                              | ✅           | single-tweet path, off the hot path                                  |
| `GenericTimelineById`                                                                                                                                                              | ✅           | unused                                                               |
| `TrendHistory`                                                                                                                                                                     | ✅           | _newly permitted since the design probe_ — trend metadata, no tweets |
| `SearchTimeline`, `ListSearchTimeline`, `ExplorePage`, `TrendRelevantUsers`, `Followers`, `Following`, `SimilarPosts`, `TweetDetail`, `UserMedia`, and every other narrow timeline | ❌ `404`     | —                                                                    |

That permitted set is not arbitrary: it is exactly what a logged-out browser can render —
**one profile, or one tweet**. Search is not on it, and neither is anything adjacent to
it. `TrendHistory` moving from gated to permitted between the design probe and today is
itself the point: this surface is undocumented and moves, which is why the Actor resolves
its `queryId`s at runtime rather than shipping them.

Dead ends, all tested: `SearchTimeline` via `api.x.com` / `twitter.com` / POST /
`product=Top` (`404` every variant); X's legacy iPhone bearer (rejected at
`guest/activate`); `/i/api/2/search/adaptive.json` (`403`); `cdn.syndication.twimg.com`
search and hashtag timelines (`200` with a zero-byte body); `x.com/hashtag/<tag>`
logged out (`200`, empty SPA shell); `x.com/search` with a Googlebot user-agent (`404` —
X verifies crawlers by reverse DNS, not by UA string, and we did not attempt to defeat
that).

**So keyword search as the brief describes it is not reachable from the guest surface.**
Everything below follows from that.

---

## 2. Architecture and data flow

Because search is closed but _profiles_ and _timelines_ are open, the problem splits:
**discovery** (which accounts) is separated from **extraction** (their tweets), and only
discovery ever leaves X.

```
  searchTerms / hashtags ─┐
                          ├─►  DiscoveryStrategy (port)  ──► handles
  fromUsers ──────────────┘     ├─ DirectHandleDiscovery   — zero external calls
                                └─ SeededTopicDiscovery    — one lookup per term, cold start only
                                             │
                                             ▼
                       UserByScreenName  →  userId          ← 100% native X from here down
                                             │
                                             ▼
                       UserTweets (cursor-paged, lazy)
                                             │
                    normalize → filter → dedupe → ResultSink → dataset
                                             ▲
                                    free-tier cap enforced here
```

**`UserTweets` returns complete tweet objects** — full text, all six metrics, entities,
media, author. There is no per-tweet hydration step: the cost unit is _one request ≈ 20
tweets_, not one request per tweet. This is the single biggest reason the native path is
fast (§5).

**Seed expansion is native and free.** Mentions and retweeted authors are already present
in pages we have paid for, so the account frontier grows at zero extra request cost. It is
depth-limited (default 1) because mentions from a topical account are not all topical, and
precision decays quickly.

### Why the seed is a _profile_ lookup, not a _post_ lookup

The obvious version of external discovery — search the web for tweet URLs, then hydrate
them by ID — was implemented and measured, then rejected. For a keyword query the freshest
indexed tweet was **36 days old** (median 181); a hashtag query returned **zero** tweet
URLs, only profile pages. `sortBy: latest` cannot be served honestly from a web index.

The same measurement is what makes the _handle_ variant viable: search engines index X
**profiles** well and X **posts** slowly. So we ask them the question they can answer —
_who talks about this_ — and get recency from X itself.

The lookup runs **once per run, at cold start**, is **skipped entirely** when `fromUsers`
is supplied, and sits behind a port so it can be swapped for a static roster without
touching extraction.

### Discovery is a cascade, not a dependency

Measured 2026-08-17 from a single IP after roughly a dozen queries: DuckDuckGo began
answering `202` with a 14 KB anti-bot challenge, while Brave answered `200` with usable
results on the same query in the same minute. Mojeek and Ecosia returned `403`; Bing
returned `200` but wraps every result in a base64 redirect, so no handles are recoverable
from its HTML.

So `SeededTopicDiscovery` walks an ordered list of engines — cheapest first, since this
traffic crosses the same paid proxy — and the first one that yields handles wins. A
blocked engine falls through; a throwing engine does not fail the run; all engines blocked
yields no seeds and a logged warning rather than a crash.

### Alternatives considered

| Option                                                       | Why not                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paid tweet-search API** (e.g. a pay-per-event Apify actor) | Returns keyword results immediately, but then the X-specific extraction is the vendor's work, not ours. Worth noting that `apidojo-io/twitter-scraper-lite`, the widely-referenced "X scraper", contains **no HTTP calls to X at all**: it is an `apify_client` wrapper around paid actor `nfp1fpt5gUlBwPcor`. |
| **X official API v2 recent search**                          | Legitimate, but needs a paid app bearer — a hardcoded server-side credential, which is the mechanism §3 rules out.                                                                                                                                                                                             |
| **Search index → tweet IDs → hydrate**                       | Measured and rejected: 36-day-old freshest result, zero hashtag coverage.                                                                                                                                                                                                                                      |
| **Logged-in account pool**                                   | Prohibited by §3.                                                                                                                                                                                                                                                                                              |

---

## 3. The browserless approach

No browser engine is installed and none is needed. The whole client is
[`got-scraping`](https://github.com/apify/got-scraping) behind a one-function port:

```ts
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
```

Everything that leaves the process goes through it, which is what makes 154 tests run
offline in 0.4 s with no module mocking. It is deliberately status-code-transparent: a
`404` or `429` is a _response_, not an exception, because the error taxonomy cannot
classify what the transport already threw away.

Three pieces of protocol knowledge make the browserless path work:

**1. `queryId`s must be resolved at runtime.** They rotate with every X frontend deploy —
we observed three distinct bundle hashes across three days (`main.e4aca26a.js` →
`main.4f5b42da.js` → `main.b07c4c6a.js`), one change inside a single afternoon. The Actor
fetches `x.com/explore` (not `x.com/`, which serves a server-rendered login wall with no
app bundle), extracts `main.<hash>.js`, and parses the webpack modules that carry
`{queryId, operationName, metadata:{featureSwitches, fieldToggles}}`. Cached for the run,
refreshed exactly once on an unexpected `404`, then fatal.

**2. Extract by path, never by type.** Tweets are read at exactly
`instructions[].entries[].content.itemContent.tweet_results.result` (and the module
variant one level deeper), and never recursed into. A tweet's `retweeted_status_result`
and `quoted_status_result` are structurally identical to a top-level tweet, so the
tempting `__typename === "Tweet"` walk turns a 20-entry page into **32 items** — the same
content emitted two and three times. Pinned entries are skipped, because a pinned tweet is
an arbitrarily old tweet served at the top of the timeline and silently corrupts
`sortBy: latest`.

**3. `TimelineTerminateTimeline` is advisory, and obeying it is a 79% recall bug.**

The instruction carries a `direction`, and the obvious reading — "terminated means stop
paging" — is wrong:

| Account  | Page 0    | `direction`    | Following the cursor anyway            |
| -------- | --------- | -------------- | -------------------------------------- |
| `@apify` | 19 tweets | `TopAndBottom` | 5 pages, **92 unique tweets, all new** |
| `@naval` | 98 tweets | `TopAndBottom` | no cursor issued at all                |

X emits `TopAndBottom` on _every_ page of a paginated timeline while the bottom cursor
keeps returning fresh tweets. Obeying it truncates `@apify` from 92 tweets to 19, and
nothing errors — the logs look perfectly healthy. The Actor therefore stops on
**structural** signals instead: no bottom cursor, a page that did not advance the cursor,
an empty page, or a page containing nothing new.

That table also documents a second finding worth knowing: guests see **two response
modes** — paginated (~17–20 tweets per page plus a working cursor) and single-snapshot
(~98–100 tweets, no cursor, non-chronological order). The extractor handles both.

### Normalization: the text pipeline, in order

```
1. SELECT SOURCE OBJECT   isRetweet ? legacy.retweeted_status_result.result : self
2. SELECT TEXT FIELD      note_tweet…result.text  ??  legacy.full_text
3. EXPAND t.co            → entities[].expanded_url  (urls *and* media)
4. DECODE HTML ENTITIES   &amp; &lt; &gt;            ← last
```

Each step exists because of a measured failure:

- **Step 1.** A retweet's own `legacy.full_text` is the `"RT @handle: …"` wrapper. Its
  _metrics_ are worse: the wrapper on our fixture reports `favorite_count: 0` against the
  original's `13`, so reading the wrapper would make `minLikes: 1` silently discard every
  retweet in the run. Retweet metrics come from the original; identity, author and
  timestamp stay the retweet's own.
- **Step 2.** Long-form posts keep their full text in `note_tweet`. Note that the
  truncated version can be _longer_ in raw characters — measured 302 vs 283 on one
  `@apify` post, because X appends a 23-character t.co pointer to the text it cut off
  (`display_text_range` ends at 278). A "take whichever string is longer" heuristic emits
  the truncated text. When `note_tweet` supplies the text, entities come from its
  `entity_set`, not from `legacy.entities`.
- **Step 3.** The trailing photo/video link is a t.co too, but it lives in
  `entities.media[]`, not `entities.urls[]` — expanding only the latter leaves a bare
  `https://t.co/…` in the text of every tweet with media.
- **Step 4 is last** because X's `indices` are offsets into the _raw_ string: decoding
  `&amp;` (5 chars) to `&` (1 char) shifts every later offset by four. We sidestep index
  arithmetic entirely by replacing t.co tokens as strings, which also avoids a second
  trap — X computes indices in Unicode code points while JavaScript slices in UTF-16 code
  units, so one emoji earlier in a tweet desynchronises them.

Two schema notes that most published scrapers get wrong today: **`legacy.followers_count`
no longer exists** (follower data is at `user_results.result.relationship_counts`), and
`screen_name`/`name` now live under `core`, not `legacy`.

---

## 4. Free-tier protection

**Requirement:** unverified users get at most 10 results per run, and the Actor must
_stop fetching and pushing_ at 10 regardless of input. Client-side limits do not count as
protection, and environment variables are not trusted.

### 4.1 Identity comes from the credential, not the claim

```ts
const me = await new ApifyClient({ token: process.env.APIFY_TOKEN }).user('me').get();
```

Not `APIFY_USER_ID`. Per Apify's own docs that variable is "ID of the user who started the
Actor" — an environment variable, which the brief explicitly names as untrusted. The token
is strictly stronger: it is a credential _the authority validates_. Asking the platform
"whose token is this?" is self-validating — a forged token is either rejected (→ fail
closed → free) or genuinely someone else's (→ correctly returns _their_ entitlement).

### 4.2 The entitlement store is public on purpose

Here is the trap that breaks the obvious design: **inside a run, `APIFY_TOKEN` belongs to
the runner.** `Actor.getValue()`, `Actor.apifyClient` and the default key-value store are
all authenticated _as them_. A private store on our account is simply unreachable from
inside the run.

So the store is **public-read, and the authority is write access**, which stays ours:

- a runner's own token can read it, so no shared secret is needed at read time;
- public reads cannot change a verdict;
- keys are `HMAC-SHA256(runnerUserId)`, so a world-readable store leaks no customer IDs;
- **blast radius:** if an Apify API token leaked, an attacker could write to the store and
  grant themselves paid. If the HMAC key leaked, they could compute a key in a store that
  was already public. We put the authority behind the credential whose leak costs less.

`ENTITLEMENTS_HMAC_KEY` **must be marked Secret** in the Apify Console: a published
Actor's non-secret environment variables are publicly visible on its detail page, so a
plain env var would publish the authority itself.

### 4.3 One chokepoint, lazily consumed

```ts
async push(item: T): Promise<boolean> {
  if (this.pushed >= this.opts.cap) return false;  // check…
  this.pushed++;                                   // …and increment, with no await between
  await this.opts.push(item);
  return this.pushed < this.opts.cap;
}
```

```ts
for await (const tweet of crawl(seeds)) {
  // lazy: pages cursors only when pulled
  if (!matches(tweet, filters)) continue;
  if (!(await sink.push(tweet))) break; // unwinds the whole generator chain
}
```

`break` stops the consumer, which stops the crawl, which stops cursor paging — and
`mergeConcurrent` returns every in-flight account chain so none keeps paging in the
background. **A free user who asks for 1000 results costs us one page.** That is asserted
directly: the test drives a 100-page source and asserts exactly one page was fetched and
the generator was closed.

`maxResults` is also clamped up front, as an optimisation — but the clamp is not the
protection, and the input schema deliberately carries **no `"maximum": 10`**. A limit
expressed in the input is exactly the client-side artifact the brief rejects, and it would
break paying users.

The check-then-increment ordering is load-bearing under concurrency: with N account chains
feeding one sink, any `await` between the check and the increment lets every worker pass
the check on the same value. A test fires 50 concurrent pushes at a slow sink and asserts
10; swapping those two lines fails it with 50 (verified by mutation).

### 4.4 Fail closed, and say which kind of closed

```ts
const isPaid = entitlement?.paid === true; // ✅ undefined → false → free
// const isPaid = entitlement?.paid !== false;  ❌ undefined → true → unlimited
```

Every path resolves to free: a throw, a `null` record, a malformed record, a `paid` field
that is the _string_ `"true"`. Zod validates the record so `undefined` can never reach a
boolean.

The verdict distinguishes two cases that share a cap but not a meaning:

```jsonc
{ "limited": true, "reason": "free_tier",               "cap": 10 }  // verified free
{ "limited": true, "reason": "entitlement_unavailable", "cap": 10 }  // could not verify
```

The second is the **alertable** one — it may be capping a paying customer because of our
own outage — and it is emitted as a warning, not an info line.

### 4.5 The bypass that state persistence creates

The run's key-value store belongs to the runner, so a persisted counter is
attacker-writable:

```
1. Free run pushes 10, persists { pushed: 10 }.
2. User PUTs { pushed: 0 } with their own token.
3. User resurrects the run → resumes at 0 → 10 more into the same dataset.
4. Repeat.
```

A naive resume gives 20 on the first resurrect with no tampering at all. The fix is to
floor the counter on an authority the user cannot lower:

```ts
const pushed = Math.max(persisted.pushed ?? 0, dataset.itemCount);
```

They cannot reduce `itemCount` without deleting the results they were trying to
accumulate. Entitlement is also re-resolved on resume and never cached in runner-writable
storage. The principle: _persisted state is fine for cursors — worst case the user
re-scrapes and pays for it. It is not fine for the counter that enforces the cap._

### 4.6 Anti-fork: an honest answer

- **Layer 0 — Distribution.** Production: private repo. _(This submission is public by
  requirement.)_
- **Layer 1 — Platform.** `Settings → Hide source files from Actor detail`, or the Store
  republishes the source regardless of where git lives.
- **Layer 2 — Credential.** The HMAC key as a Secret env var: absent from the repo, absent
  from the public env listing, unreadable via API or Console.
- **Layer 3 — Authority.** The verdict comes from a store only our token can write. A fork
  cannot _impersonate_ a paid user — only _delete the check_.
- **Layer 4 — The honest limit.** Deletion is unpreventable. A _permission_ check asks the
  server a question and can be removed; only a _capability_ the server supplies cannot.
  A capability moat has to rest on something expensive to reproduce or perishable — and
  guest tokens are freely mintable while queryIds are freely extractable, so this task has
  no genuine capability moat. The real moat is the Store listing, maintained queryId
  resolution, and operational upkeep.

The endpoint of that reasoning is instructive: `apidojo-io/twitter-scraper-lite` is a
public repo with **no HTTP calls to X at all** — a thin wrapper around a paid actor. It is
perfectly fork-proof, because forking it yields nothing. We deliberately did not go there:
the brief asks for a browserless extractor, not a billing wrapper. **This gate is fully
tamper-proof and explicitly not fork-proof, and that is the right trade for this
deliverable.**

---

## 5. Measured performance

The brief's benchmark ("a broad keyword, `sortBy: latest`, 100 items") exercises
`SearchTimeline`, which is gated (§1). We keep the **protocol** and substitute the query,
and we declare the substitution rather than hide it:

- the timer starts at the first outbound request of the measured phase;
- it stops at the 100th schema-conforming item;
- cold start is excluded — queryId resolution and the first guest token are once-per-run
  costs, measured separately;
- the run must stay clean: any `429` invalidates the measurement.

Reproduce with `npx tsx src/tools/benchmark.ts native …` / `… seeded …`.
Measured 2026-08-17, macOS, **no proxy** (direct residential connection):

|                       | **Native path**              | **Full seeded path**                       |
| --------------------- | ---------------------------- | ------------------------------------------ |
| Query                 | 10 handles, `sortBy: latest` | keyword `"web scraping"`, seeded discovery |
| Items                 | **100**                      | 58 _(seed set exhausted before 100)_       |
| Wall clock            | **2.90 s**                   | 53.6 s                                     |
| Per item              | **29 ms**                    | 925 ms                                     |
| Requests              | 12                           | 192                                        |
| Pages fetched         | 6                            | 160                                        |
| Tweets fetched        | 119                          | 3,571                                      |
| Selectivity           | 84%                          | 1.6%                                       |
| Guest tokens used     | 1                            | 5                                          |
| Transferred           | 3.2 MB                       | 34.3 MB                                    |
| `429` count           | **0**                        | **0**                                      |
| Cold start (excluded) | 1.4 s                        | 1.3 s                                      |

Derived cost per 1,000 results, at Apify list prices (residential proxy $12.50/GB, compute
unit $0.40) — the constants live in `src/actor/summary.ts` so they can be corrected for
your plan:

|           | Native               | Seeded              |
| --------- | -------------------- | ------------------- |
| Proxy     | 0.032 GB → **$0.40** | 0.59 GB → **$7.39** |
| Compute   | 0.008 CU → $0.003    | 0.26 CU → $0.10     |
| **Total** | **≈ $0.41 / 1k**     | **≈ $7.49 / 1k**    |

**Read the gap, not the headline.** The 32× difference between the two paths is the
architecture stating its own limitation: native extraction from known handles is fast and
cheap, and keyword _matching_ is expensive because recall is seed-bounded and selectivity
is low. An earlier run of the same keyword against weaker seeds measured 0.09%
selectivity, 518 requests, 91 MB and an implied $128/1k. That measurement is why the Actor
has a **request budget** (`maxRequests`, default 500): without one, run cost is bounded
only by how many accounts exist. When the budget stops a run, the summary says so
(`budgetExhausted: true`).

Every run writes the same diagnostics to `OUTPUT`, so any claim here can be re-derived
rather than trusted:

```jsonc
{
  "requested": 100,
  "fetched": 119,
  "pushed": 100,
  "limited": false,
  "reason": null,
  "cap": null,
  "discoveryStrategy": "direct",
  "seedsResolved": 10,
  "accountsCrawled": 6,
  "pagesFetched": 6,
  "filteredOut": 19,
  "selectivity": 0.8403,
  "duplicatesDropped": 0,
  "accountsSkipped": { "protected": 0, "suspended": 0, "notFound": 0 },
  "budgetExhausted": false,
  "tokensConsumed": 1,
  "xRequests": 12,
  "totalRequests": 14,
  "bytesTransferred": 3200000,
  "errors": { "429": 0, "403": 0, "404": 0, "5xx": 0, "timeout": 0, "other": 0 },
  "estimatedCostPer1kResults": { "proxyGB": 0.032, "computeUnits": 0.008, "usd": 0.41 },
  "wallClockMs": 2902,
}
```

### Why the design looks like this

The binding constraint is the **request budget**, not latency: X grants ~50 requests per
15 minutes per guest token, a page is ~20 tweets, and a page costs ~700–900 ms. That is
why a _pool_ of triples is the core design rather than an optimisation, and why the
response to a `429` is to rotate rather than to sleep — a fresh token costs ~200 ms, and
waiting 15 minutes for a free resource is the largest throughput mistake available here.
Better still, triples retire at ≤5 remaining requests, so the `429` is never taken at all;
both benchmark runs report zero.

Parallelism runs **across accounts**, because a cursor chain cannot be parallelised
internally — page 2 needs page 1's cursor.

> If `SearchTimeline` were available, the A-grade path would be time-window sharding:
> split `since`/`until` into N sub-ranges, run N independent cursor chains in parallel,
> and merge through the global seen-set. A single cursor chain is inherently sequential, so
> sharding the query is the only way to parallelise search paging — the same reason this
> design parallelises across accounts rather than across pages.

---

## 6. Output contract and the rulings behind it

Every item conforms exactly to the required shape. **Missing values are `null` — never
omitted, never `undefined`** — so the dataset has a stable column set. Timestamps are
ISO-8601 UTC, counts are integers, IDs are strings (never JS numbers — they exceed
`Number.MAX_SAFE_INTEGER`).

```jsonc
{
  "id": "2088525549626867786",
  "url": "https://x.com/apify/status/2088525549626867786",
  "text": "…",
  "lang": "en",
  "createdAt": "2026-08-15T07:17:48.000Z",
  "conversationId": "2088525549626867786",
  "isReply": false,
  "isRetweet": true,
  "isQuote": false,
  "inReplyToId": null,
  "quotedTweetId": null,
  "author": {
    "id": "3510729917",
    "username": "apify",
    "name": "Apify",
    "verified": false,
    "followers": 11840,
    "following": 296,
  },
  "metrics": {
    "likes": 13,
    "retweets": 1,
    "replies": 0,
    "quotes": 0,
    "bookmarks": 1,
    "views": 713,
  },
  "entities": {
    "hashtags": [],
    "mentions": ["apify"],
    "urls": [],
    "media": [{ "type": "photo", "url": "…", "thumbnail": "…" }],
  },
  "source": "Twitter Web App",
  "scrapedAt": "2026-08-17T10:15:00.000Z",
}
```

The brief leaves several behaviours undefined. Each is decided, tested, and documented
here so documented behaviour can be diffed against actual behaviour:

| Ruling                        | Decision                                                   | Why                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mediaType: images`           | matches if **≥1 photo**, other content allowed             | "tweets with images" is the natural reading; "photos only" surprises                                                                                                                                       |
| `animated_gif`                | grouped under `video`                                      | X stores GIFs as MP4, and the enum has no `gif` value                                                                                                                                                      |
| `mediaType: links`            | ≥1 entry in `entities.urls`                                | —                                                                                                                                                                                                          |
| `mediaType: text_only`        | **no media AND no links**                                  | `links` is its own enum value, so allowing links here makes the enum incoherent                                                                                                                            |
| `onlyVerified`                | `is_blue_verified \|\| verification.verified`              | X conflates paid Blue with legacy verification and the schema has one boolean. Never key off `verified_type`: `@grok` returns `verified_type: "Business"` with `verified: false` while being blue-verified |
| `includeReplies` default      | `false`                                                    | the brief specifies the default only for retweets; we default both and say so                                                                                                                              |
| `sortBy: latest`              | descending Snowflake ID                                    | IDs are monotonic, so ID order **is** chronological order                                                                                                                                                  |
| `sortBy: top`                 | descending `likes + retweets` **within the collected set** | X's relevance ranking is not reproducible from the guest surface — approximation, declared                                                                                                                 |
| `since` / `until`             | **inclusive**, applied to the Snowflake                    | a bare date in `until` covers the whole day to `23:59:59.999`; treating it as midnight silently drops a day                                                                                                |
| `toUsers`                     | reply **that mentions** the handle                         | X puts the parent author in `user_mentions` on every reply; there is no mention index on the guest surface                                                                                                 |
| Multiple values in one filter | OR                                                         | `hashtags: ["a","b"]` means a **or** b                                                                                                                                                                     |
| Multiple filters              | AND                                                        | and an unspecified filter is **no constraint**, never a narrowing one                                                                                                                                      |
| Missing metric vs `minLikes`  | counts as 0                                                | absent data is not evidence of engagement                                                                                                                                                                  |
| Retweet metrics               | the **original's**                                         | the wrapper's counters are structurally zero (§3)                                                                                                                                                          |

Results are buffered and written in one batch at the end, because `sortBy` is a property
of the whole result set and cannot be honoured by an append-only stream. The buffer is
bounded by the cap and checkpointed on migration.

---

## 7. Running it

### On Apify

1. Push the Actor (`apify push`) or build from this repo.
2. Set environment variables:
   - `ENTITLEMENTS_STORE_ID` — `username/store-name` of a **public-read** key-value store
     that only your account can write.
   - `ENTITLEMENTS_HMAC_KEY` — **mark this Secret.** Without it, every run resolves to
     `entitlement_unavailable` and is capped at 10, which is the correct fail-closed
     behaviour but not what you want in production.
3. Grant paid access by writing `{"paid": true}` to the store under key
   `HMAC-SHA256(userId, ENTITLEMENTS_HMAC_KEY)` in hex.

### Locally

```bash
npm install
echo '{"fromUsers":["apify","naval"],"maxResults":100}' \
  > storage/key_value_stores/default/INPUT.json
npm run start:dev
```

With no entitlement store configured, local runs cap at 10 and log
`entitlement_unavailable` — the gate failing closed, which you can watch happen.

A residential proxy is recommended (`proxyConfiguration: {"useApifyProxy": true,
"apifyProxyGroups": ["RESIDENTIAL"]}`). X rate-limits per token and per IP, and the seed
lookup is more likely to be challenged from a datacenter IP.

### Development

|                                                         |                                          |
| ------------------------------------------------------- | ---------------------------------------- |
| `npm test`                                              | 154 tests, offline, no platform          |
| `npm run typecheck` / `npm run lint`                    | strict TS, ESLint                        |
| `npm run probe`                                         | reproduce the endpoint capability matrix |
| `npx tsx src/tools/capture-fixtures.ts <handles…>`      | refresh committed fixtures from live X   |
| `npx tsx src/tools/benchmark.ts native \| seeded <arg>` | reproduce §5                             |

Layering is one-way — `actor → adapters → domain` — and `domain/` imports nothing from
the other two. Every seam is constructor injection; there is no module mocking anywhere in
the suite. See `CLAUDE.md` for the full conventions.

---

## 8. ToS, robots.txt, and what we would raise with a client

`https://x.com/robots.txt` sets `User-agent: * → Disallow: /`. The `Allow:` rules for
`/search`, `/hashtag/*` and `/i/api/` apply only to the named `Googlebot`/`Bingbot` group.
An automated client that is not a verified search-engine crawler is therefore outside what
robots.txt permits, and X's Terms separately restrict automated access.

We tested whether that crawler allowance was user-agent-gated: it is not. Requesting
`/search` with a Googlebot user-agent returns `404`, because X verifies crawler identity by
reverse DNS. We did not attempt to defeat that.

This Actor collects **public data only**, uses no account credentials, and holds a
conservative request rate. Before running it for a client in production we would raise:

1. robots.txt does not permit it, and a commercial agreement or X's licensed API is the
   compliant path at scale;
2. GDPR/CCPA obligations — tweets and author profiles are personal data, so a lawful basis
   and a retention policy are required;
3. guest-token access is undocumented and can be withdrawn without notice, as
   `SearchTimeline` itself demonstrates.

---

## 9. Known limitations and what is out of scope

- **Keyword and hashtag recall is seed-bounded.** You get matching tweets from accounts
  that discuss the topic, not every tweet on X. This is a hard ceiling of the guest
  surface, not an implementation shortcut. The run summary reports how many accounts were
  seeded and crawled so callers can judge coverage.
- **`sortBy: top` is an approximation** — engagement ranking within the collected set.
- **The §8 benchmark is substituted**, with methodology declared (§5).
- **`toUsers` / `mentioning` are client-side filters** over the crawled set, not a mention
  index. No such index is reachable.
- **Fixtures cannot detect X changing its response shape.** The suite is offline and
  deterministic by choice, and the cost of that choice is that these tests stay green while
  production breaks. In a production system this is closed with a scheduled, non-blocking
  contract test against the live API that alerts on drift; `src/tools/capture-fixtures.ts`
  makes re-capturing a one-command job. Out of scope here, and stated rather than papered
  over.
- **The seed lookup depends on third-party search engines**, which challenge automated
  traffic (§2). The cascade mitigates it; `fromUsers` removes the dependency entirely.
- **Buffered output** trades peak memory for correct ordering. At the scale this Actor
  targets (hundreds to low thousands of results) that is the right trade; a
  hundred-thousand-result run would want a spill-to-disk merge sort instead.

Delivered from the bonus list: global deduplication and a seen-set (required anyway, given
nested retweets and snowball overlap); protected / suspended / deleted account handling
(one dead account never fails a run); and cost-per-1k reporting.

---

## 10. Decisions and trade-offs

1. **Separate discovery from extraction, and put discovery behind a port.** The one part
   of the problem X does not permit is isolated in one swappable adapter, and the other 95%
   of the system is native and unaffected by that choice.
2. **Ask a web index about profiles, not posts.** Driven by measurement — 36-day-old
   freshest indexed tweet, zero hashtag coverage — not by preference.
3. **Refuse to solve the hard part by buying it.** A paid search API would have made
   keyword search work immediately and made the extraction someone else's work.
4. **Resolve `queryId`s at runtime.** Three bundle hashes in three days; hardcoding
   guarantees a silent failure on some future Tuesday.
5. **Extract by path; never recurse.** Recursion double-counts nested originals — 32 items
   from a 20-entry page.
6. **Distrust X's own stop signal.** `TimelineTerminateTimeline` costs 79% of recall on a
   paginated account if believed.
7. **Pin the session triple; rotate on `429`; retire before the limit.** Coherence is what
   abuse detection looks for, and a proactive retirement is worth more than any backoff.
8. **Enforce the cap at a single lazy chokepoint.** It stops fetching, not just pushing —
   and the seam is constructor injection, so the required test needs no network.
9. **Derive identity from the token, not the environment; fail closed on every path.**
10. **Floor the resume counter on `dataset.itemCount`.** Persisted state is fine for
    cursors and unacceptable for the counter that enforces the cap.
11. **Budget requests explicitly.** Low selectivity is normal, and without a budget the
    cost of a run is bounded only by how many accounts exist.
12. **Publish the diagnostics that would let a reviewer contradict us.** Selectivity,
    tokens, bytes, `429` count and cost are all in `OUTPUT`.
