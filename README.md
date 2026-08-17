# x-tweet-scraper

A browserless X (Twitter) scraper, shipped as an Apify Actor.

No browser engine, no account credentials, no purchased tweet data. It talks to X's own
GraphQL API over plain HTTP with guest tokens, the same surface a logged-out visitor gets,
and it ships with a free-tier limit that lives on the server and cannot be lifted by
editing the input.

Two things about it are worth your time. The first is that **X gates keyword search for
guest tokens**, which quietly invalidates the obvious design — so the Actor takes a
different route to the same data, and §1–§2 show the measurements that forced it. The
second is the **free-tier gate** in §4, which is harder than it looks: the run executes on
the customer's own Apify account, holding the customer's own token, writing to the
customer's own storage. Almost every natural place to put the limit is somewhere they
control.

|         |                                                    |
| ------- | -------------------------------------------------- |
| Store   | https://apify.com/arthurvianna/x-tweet-scraper     |
| Source  | https://github.com/ArthurVianna96/x-tweet-scraper  |
| Console | https://console.apify.com/actors/PNZugrwspnmMj70at |

```bash
npm install
npm test                     # 221 tests, offline, ~0.5s
npm run probe                # re-derive the endpoint capability matrix (~20s, no credentials)
npm run start:dev            # run the Actor locally
```

Every measurement quoted below is reproducible. `npm run probe` re-runs the endpoint
probe, `src/tools/benchmark.ts` re-runs the performance numbers, and every run writes its
own diagnostics to `OUTPUT` so you can contradict the claims with the Actor itself. The
raw evidence, with dates, is in [`docs/README-data-source.md`](docs/README-data-source.md).

### Which surfaces are implemented

The brief (§2a) asks us to say this plainly, so:

| Surface                | Operation                           | Status                                      |
| ---------------------- | ----------------------------------- | ------------------------------------------- |
| **Tweets by author**   | `UserTweets`                        | ✅ required — the extraction engine         |
| **Single tweet by id** | `TweetResultByRestId`               | ✅ required — `tweetIds`, one request each  |
| **Profile by handle**  | `UserByScreenName`                  | ✅ required — returns §5's `author` in full |
| **Free-text search**   | `SearchTimeline` is `404` to guests | ⚠️ **stretch, served a different way** (§2) |

All three required surfaces are guest-reachable, browserless, and at the §5 schema.

`searchTerms` works, but not through X: X's search timeline is walled to guests, so the
keywords are answered by seeding account discovery from a public web index and filtering
natively (§2). That is the "equivalent public HTTP source you justify" route rather than
the programmatic-auth route, and its honest limitation is that **recall is seed-bounded** —
you get matching tweets from accounts that discuss the topic, not every tweet on X (§9).
It is not rejected as unsupported; it is implemented, measured, and scoped.

---

## Contents

1. [The finding everything rests on](#1-the-finding-everything-rests-on)
2. [Architecture: separating _who_ from _what_](#2-architecture-separating-who-from-what)
3. [Scraping X without a browser](#3-scraping-x-without-a-browser)
4. [The free tier you cannot edit away](#4-the-free-tier-you-cannot-edit-away)
5. [Speed and cost, measured](#5-speed-and-cost-measured)
6. [Output contract, and the calls behind it](#6-output-contract-and-the-calls-behind-it)
7. [Running it](#7-running-it)
8. [robots.txt, ToS, and what we would tell a client](#8-robotstxt-tos-and-what-we-would-tell-a-client)
9. [What it cannot do](#9-what-it-cannot-do)
10. [Decisions and trade-offs](#10-decisions-and-trade-offs)

---

## 1. The finding everything rests on

The brief says X's search timeline is auth-walled to guests, and asks us to work out
**which operations are guest-reachable today** and scope the feature set around them. So
the interesting question is not whether `SearchTimeline` is closed — it is closed — but
where exactly the wall runs.

`SearchTimeline` returns `404` with a zero-length body to a guest token, from every host,
method and product variant we tried. The guest tokens themselves are perfectly healthy;
the gate is on the _operation_.

Rather than take that on trust, `npm run probe` re-derives the whole matrix in about 20
seconds without credentials. The method turns on one useful detail: **X distinguishes
refusal from rejection by status code.**

| Status                          | What it means                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `404`, zero-length body         | operation **gated** — refused before X even validated the request            |
| `422 GRAPHQL_VALIDATION_FAILED` | operation **permitted** — it reached validation and our variables were wrong |
| `200`                           | operation **permitted**                                                      |

So a `404` here is not a typo in a path or a stale `queryId`. Operations that _are_
permitted answer with a descriptive `422` on the same token in the same second.

Of 23 operations probed on 2026-08-17, **five are open to guests**:

| Open to guests        | What it gives us                                                  |
| --------------------- | ----------------------------------------------------------------- |
| `UserTweets`          | **the extraction engine** — full tweet objects + cursors          |
| `UserByScreenName`    | the profile surface — handle → `userId` and §5's `author`         |
| `TweetResultByRestId` | the by-id surface — one fully hydrated tweet per `tweetIds` entry |
| `GenericTimelineById` | unused                                                            |
| `TrendHistory`        | trend metadata, no tweets — _and newly permitted_                 |

Everything else is `404`: `SearchTimeline`, `ListSearchTimeline`, `ExplorePage`,
`TrendRelevantUsers`, `Followers`, `Following`, `SimilarPosts`, `TweetDetail`, `UserMedia`,
`UserOriginalsTimeline` and every other narrow timeline variant. That permitted set is not arbitrary — it is exactly
what a logged-out browser can render: **one profile, or one tweet.** Search is not on it,
and neither is anything adjacent to it. It also maps one-to-one onto the three required
surfaces, which is the point: the doors that are open are exactly the ones the brief asks
us to build on.

`TrendHistory` is the interesting entry. It was gated on 2026-08-14 and permitted on
2026-08-17. This surface is undocumented and it moves, which is the whole argument for
resolving `queryId`s at runtime instead of shipping them (§3).

We looked for a way around the gate before accepting it. Every attempt failed, including
`SearchTimeline` via `api.x.com` / `twitter.com` / POST / `product=Top`, X's legacy iPhone
bearer, `/i/api/2/search/adaptive.json`, the `cdn.syndication.twimg.com` timelines, and
`x.com/hashtag/<tag>` logged out. Requesting `/search` with a Googlebot user-agent also
returns `404` — X verifies crawlers by reverse DNS rather than by UA string, and we did
not attempt to defeat that. The full list, with status codes, is in
[the appendix](docs/README-data-source.md#3-workarounds-ruled-out).

**Free-text search is not reachable from the guest surface.** The three required surfaces
are. Everything below follows from that.

---

## 2. Architecture: separating _who_ from _what_

Search is closed, but profiles and timelines are wide open. So the problem splits in two:
work out **which accounts** to read, then **read their tweets**. Only the first half ever
leaves X, and it happens once.

```
  tweetIds ───────────────────────────►  TweetResultByRestId  ─┐   one request per id
                                                               │
  searchTerms / hashtags ─┐                                    │
                          ├─►  DiscoveryStrategy (port) ─┐     │
  fromUsers ──────────────┘     ├─ DirectHandleDiscovery │     │
                                └─ SeededTopicDiscovery  │     │
                                                         ▼     │
                                      UserByScreenName → userId│  ← 100% native X from here
                                                         │     │
                                                         ▼     │
                                      UserTweets (cursor-paged)│
                                                         │     │
                                                         ▼     ▼
                    normalize → filter → dedupe → ResultSink → dataset
                                             ▲
                                    free-tier cap enforced here
```

Both sources are lazy generators feeding one sink, which is what lets the cap stop the
_fetching_ on either surface (§4.3).

That split is what keeps the compromise contained. Discovery sits behind a port, so the
one part of the problem X refuses to help with is isolated in a single swappable adapter —
and the other 95% of the system neither knows nor cares which strategy ran.

**`UserTweets` returns complete tweet objects** — full text, all six metrics, entities,
media, author. Nothing needs a second hydration call. The cost unit is _one request ≈ 20
tweets_, not one request per tweet, and that single fact is why the native path is fast
(§5).

**Growing the account set is free.** Mentions and retweeted authors are already sitting in
pages we have paid for, so the frontier expands at zero extra request cost. It is
depth-limited (default 1) because mentions from a topical account are not all topical, and
precision decays quickly.

### Why we ask a search engine about people, not posts

The obvious version of external discovery is to search the web for tweet URLs and hydrate
them by id. We built that, measured it, and threw it away.

For a keyword query the freshest indexed tweet was **36 days old** (median 181). A hashtag
query returned **zero** tweet URLs — only profile pages. You cannot serve `sortBy: latest`
honestly out of a web index.

The same measurement is what rescues the _handle_ variant. Search engines index X
**profiles** well and X **posts** slowly. So we ask them only the question they can
actually answer — _who talks about this?_ — and get recency from X itself. The lookup runs
**once per run at cold start**, is **skipped entirely** when `fromUsers` is supplied, and
sits behind the port so it can be swapped for a static roster without touching extraction.

### Discovery is a cascade, not a dependency

Search engines fight automation, and they do not fight it consistently. Measured
2026-08-17 from one IP after roughly a dozen queries: DuckDuckGo started answering `202`
with a 14 KB anti-bot challenge, while Brave answered `200` with usable results on the
same query in the same minute. Mojeek and Ecosia returned `403`. Bing returned `200` but
wraps every result in a base64 redirect, so no handles survive its HTML.

So `SeededTopicDiscovery` walks an ordered list of engines — cheapest first, since this
traffic crosses the same paid proxy as everything else — and the first one that yields
handles wins. A blocked engine falls through. A throwing engine does not fail the run. All
engines blocked yields no seeds and a logged warning, not a crash.

### What we considered instead

| Option                                                       | Why not                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paid tweet-search API** (e.g. a pay-per-event Apify actor) | Keyword results immediately — and the X-specific extraction becomes the vendor's work, not ours. Worth knowing: `apidojo-io/twitter-scraper-lite`, the widely-referenced "X scraper", makes **no HTTP calls to X at all**. It is an `apify_client` wrapper around paid actor `nfp1fpt5gUlBwPcor`. |
| **X official API v2 recent search**                          | Legitimate, but needs a paid app bearer — a hardcoded server-side credential, which is exactly the mechanism §3 rules out.                                                                                                                                                                        |
| **Search index → tweet IDs → hydrate**                       | Measured and rejected: 36-day-old freshest result, zero hashtag coverage.                                                                                                                                                                                                                         |
| **Logged-in account pool**                                   | Prohibited by §3 of the brief.                                                                                                                                                                                                                                                                    |

---

## 3. Scraping X without a browser

No browser engine is installed and none is needed. The entire client is
[`got-scraping`](https://github.com/apify/got-scraping) behind a one-function port:

```ts
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
```

Everything that leaves the process goes through that function. It is why 221 tests run
offline in ~0.5 s with no module mocking anywhere: a test hands the constructor a canned
responder and asserts. The port is deliberately status-code-transparent — a `404` or `429`
is a _response_, not an exception — because the error taxonomy cannot classify what the
transport has already thrown away.

Three pieces of protocol knowledge make the browserless path actually work.

### 1. Resolve `queryId`s at runtime, never ship them

X's GraphQL endpoints are keyed by an opaque `queryId` that rotates with every frontend
deploy. We watched three distinct bundle hashes in three days —
`main.e4aca26a.js` → `main.4f5b42da.js` → `main.b07c4c6a.js` — one of those changes
landing inside a single afternoon. Hardcoding them guarantees a silent `404` on some
future Tuesday.

So the Actor fetches `x.com/explore` (not `x.com/`, which serves a server-rendered login
wall with no app bundle), extracts `main.<hash>.js`, and parses the webpack modules
carrying `{queryId, operationName, metadata:{featureSwitches, fieldToggles}}`. Cached for
the run, refreshed exactly once on an unexpected `404`, fatal after that.

### 2. Extract by path, never by type

Tweets are read at exactly
`instructions[].entries[].content.itemContent.tweet_results.result` — plus the module
variant one level deeper — and never recursed into.

The tempting alternative is to walk the payload and collect every `__typename === "Tweet"`.
It is wrong, and expensively so: a tweet's `retweeted_status_result` and
`quoted_status_result` are structurally identical to a top-level tweet, so recursion turns
a 20-entry page into **32 items**, the same content emitted two and three times.

Pinned entries are skipped for a related reason. A pinned tweet is an arbitrarily old
tweet served at the top of a timeline, and emitting it silently corrupts `sortBy: latest`.

### 3. X's own stop signal is advisory, and believing it costs 79% of recall

`TimelineTerminateTimeline` sounds like it means "stop paging". It does not.

| Account  | Page 0    | `direction`    | If you follow the cursor anyway        |
| -------- | --------- | -------------- | -------------------------------------- |
| `@apify` | 19 tweets | `TopAndBottom` | 5 pages, **92 unique tweets, all new** |
| `@naval` | 98 tweets | `TopAndBottom` | no cursor issued at all                |

X emits `TopAndBottom` on _every_ page of a paginated timeline while the bottom cursor
keeps returning fresh tweets. Obey it and `@apify` truncates from 92 tweets to 19 — and
nothing errors. The logs look perfectly healthy. This is the failure mode worth fearing:
not a crash, but a quiet 79% recall loss that no alert will ever fire on.

The Actor therefore stops on **structural** signals only: no bottom cursor, a cursor that
did not advance, an empty page, or a page containing nothing new.

That table carries a second finding too. Guests see **two response modes** — paginated
(~17–20 tweets per page plus a working cursor) and single-snapshot (~98–100 tweets, no
cursor, non-chronological). The extractor handles both. Full per-account measurements are
[in the appendix](docs/README-data-source.md#5-timeline-behaviour-measured-2026-08-17).

### Normalization: the text pipeline, in order

```
1. SELECT SOURCE OBJECT   isRetweet ? legacy.retweeted_status_result.result : self
2. SELECT TEXT FIELD      note_tweet…result.text  ??  legacy.full_text
3. EXPAND t.co            → entities[].expanded_url  (urls *and* media)
4. DECODE HTML ENTITIES   &amp; &lt; &gt;            ← last
```

Every step is there because something measurably broke without it.

- **Step 1 — read the original, not the wrapper.** A retweet's own `legacy.full_text` is
  the `"RT @handle: …"` wrapper. Worse, so are its _metrics_: the wrapper in our fixture
  reports `favorite_count: 0` against the original's `13`. Read the wrapper and
  `minLikes: 1` silently discards every retweet in the run. Metrics come from the
  original; identity, author and timestamp stay the retweet's own.

- **Step 2 — long-form text lives in `note_tweet`.** And the trap here is a good one: the
  truncated version can be _longer_ in raw characters than the complete one. Measured 302
  vs 283 on one `@apify` post, because X appends a 23-character t.co pointer to the text
  it cut off (`display_text_range` ends at 278). "Take whichever string is longer" emits
  the truncated text. When `note_tweet` supplies the text, entities must come from its
  `entity_set` too, or you are describing one string with another's offsets.

- **Step 3 — expand media links, not just URL links.** The trailing photo/video link is a
  t.co as well, but it lives in `entities.media[]`, not `entities.urls[]`. Expand only the
  latter and you leave a bare `https://t.co/…` in the text of every tweet with media —
  which is most of them.

- **Step 4 — decode last, and never index.** X's `indices` are offsets into the _raw_
  string, so decoding `&amp;` (5 chars) to `&` (1 char) shifts every later offset by four.
  We sidestep the arithmetic entirely by replacing t.co tokens as strings. That also dodges
  a second trap: X computes indices in Unicode code points while JavaScript slices in
  UTF-16 code units, so one emoji early in a tweet desynchronises them.

Two schema notes that most published scrapers still get wrong: **`legacy.followers_count`
no longer exists** — follower data moved to `user_results.result.relationship_counts` —
and `screen_name`/`name` now live under `core`, not `legacy`. More
[in the appendix](docs/README-data-source.md#6-schema-notes).

---

## 4. The free tier you cannot edit away

**The requirement:** unverified users get at most 10 results per run, and the Actor must
_stop fetching and pushing_ at 10 regardless of what the input says. Client-side limits do
not count as protection, and environment variables are not trusted.

What makes this genuinely hard is where the code runs. An Apify Actor executes **on the
customer's account, under the customer's token, writing to the customer's storage**. Most
of the obvious places to put a limit are places they own.

### 4.1 Identity comes from the credential, not the claim

```ts
const me = await new ApifyClient({ token: process.env.APIFY_TOKEN }).user('me').get();
```

Not `APIFY_USER_ID`. Per Apify's own docs that variable is "ID of the user who started the
Actor" — an environment variable, which the brief explicitly names as untrusted.

The token is strictly stronger, because it is a credential **the authority validates**.
Asking the platform "whose token is this?" is self-validating: a forged token is either
rejected (→ fail closed → free) or genuinely someone else's (→ correctly returns _their_
entitlement). There is no third outcome.

### 4.2 The entitlement store is public on purpose

Here is the trap that breaks the obvious design. **Inside a run, `APIFY_TOKEN` belongs to
the runner.** `Actor.getValue()`, `Actor.apifyClient` and the default key-value store are
all authenticated _as them_. A private store on our account is simply unreachable from
inside the run that needs to read it.

So the store is **public-read, and the authority is write access** — which stays ours:

- a runner's own token can read it, so no shared secret is needed at read time;
- public reads cannot change a verdict;
- keys are `HMAC-SHA256(runnerUserId)`, so a world-readable store leaks no customer IDs —
  it is a page of hashes that names nobody;
- **blast radius:** a leaked Apify API token would let an attacker write to the store and
  grant themselves paid. A leaked HMAC key would only let them compute a key in a store
  that was already public. We put the authority behind the credential whose leak costs
  less.

`ENTITLEMENTS_HMAC_KEY` **must be marked Secret** in the Apify Console. A published
Actor's non-secret environment variables are publicly visible on its detail page, so a
plain env var would publish the authority itself.

### 4.3 One chokepoint, consumed lazily

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
`mergeConcurrent` returns every in-flight account chain, so none keeps paging in the
background. **A free user who asks for 1000 results costs us one page.** That is asserted
directly: the test drives a 100-page source and asserts exactly one page was fetched and
the generator was closed.

The check-then-increment ordering is load-bearing under concurrency. With N account chains
feeding one sink, any `await` between the check and the increment lets every worker pass
the check on the same value. A test fires 50 concurrent pushes at a slow sink and asserts
10; swapping those two lines fails it with 50, which we verified by mutation.

**But the cap alone does not bound cost.** That is the part worth dwelling on, because it
is not obvious and it is not small.

The sink stops the run at 10 **matches**. A low-selectivity search may never reach 10 — it
exhausts the account frontier first, and the gate never engages at all. Measured on the
shipped Actor: a free run with `searchTerms: ["web scraping"]` fetched **7,287 tweets
across 284 pages, spending 328 requests and 10 guest tokens, to deliver 9 results**. The
cap was working correctly the entire time. It simply had nothing to stop.

So an unverified run is bounded on **both** axes: results by the cap, and requests by an
allowance proportional to what it may return — 10 requests per permitted result, so 100
for a 10-result cap. That is roughly 2,000 tweets scanned: a generous sample, and two
orders of magnitude below "however many accounts exist". A paid run keeps its configured
budget. Re-running that same scenario afterwards: **29 requests, 14 pages, 3 tokens, 10
results.**

`maxResults` is also clamped up front, as an optimisation — but the clamp is not the
protection, and the input schema deliberately carries **no `"maximum": 10`**. A limit
expressed in the input is exactly the client-side artifact the brief rejects, and it would
break paying users.

### 4.4 Fail closed, and say which kind of closed

```ts
const isPaid = entitlement?.paid === true; // ✅ undefined → false → free
// const isPaid = entitlement?.paid !== false;  ❌ undefined → true → unlimited
```

Every path resolves to free: a throw, a `null` record, a malformed record, a `paid` field
that is the _string_ `"true"`. Zod validates the record so `undefined` can never reach a
boolean.

The verdict then distinguishes two cases that share a cap but not a meaning:

```jsonc
{ "limited": true, "reason": "free_tier",               "cap": 10 }  // verified free
{ "limited": true, "reason": "entitlement_unavailable", "cap": 10 }  // could not verify
```

The second is the **alertable** one — it may be capping a paying customer because of our
own outage — so it is emitted as a warning rather than an info line.

### 4.5 The bypass that state persistence creates

The run's key-value store belongs to the runner, so a persisted counter is
attacker-writable:

```
1. Free run pushes 10, persists { pushed: 10 }.
2. User PUTs { pushed: 0 } with their own token.
3. User resurrects the run → resumes at 0 → 10 more into the same dataset.
4. Repeat.
```

A naive resume hands out 20 on the first resurrect with no tampering at all. The fix is to
floor the counter on an authority the user cannot lower:

```ts
const pushed = Math.max(persisted.pushed ?? 0, dataset.itemCount);
```

They cannot reduce `itemCount` without deleting the results they were trying to
accumulate. Entitlement is also re-resolved on resume and never cached in runner-writable
storage.

The principle generalises: _persisted state is fine for cursors — worst case the user
re-scrapes and pays for it. It is not fine for the counter that enforces the cap._

### 4.6 Anti-fork: the honest answer

- **Layer 0 — Distribution.** Production: private repo. _(This submission is public by
  requirement.)_
- **Layer 1 — Platform.** `Settings → Hide source files from Actor detail`, or the Store
  republishes the source regardless of where git lives.
- **Layer 2 — Credential.** The HMAC key as a Secret env var: absent from the repo, absent
  from the public env listing, unreadable via API or Console.
- **Layer 3 — Authority.** The verdict comes from a store only our token can write. A fork
  cannot _impersonate_ a paid user — it can only _delete the check_.
- **Layer 4 — The honest limit.** Deletion is unpreventable. A _permission_ check asks a
  server a question and can be removed; only a _capability_ the server supplies cannot. A
  capability moat needs something expensive to reproduce or perishable — and guest tokens
  are freely mintable while queryIds are freely extractable. **This task has no genuine
  capability moat.** The real moat is the Store listing, maintained queryId resolution, and
  operational upkeep.

Where that reasoning ends is instructive. `apidojo-io/twitter-scraper-lite` is a public
repo with no HTTP calls to X at all — a thin wrapper around a paid actor. It is perfectly
fork-proof, because forking it gets you nothing. We deliberately did not go there: the
brief asks for a browserless extractor, not a billing wrapper.

**This gate is fully tamper-proof and explicitly not fork-proof, and for this deliverable
that is the right trade.**

---

## 5. Speed and cost, measured

The brief benchmarks time to 100 valid results from **a single high-volume author**,
`sortBy: latest`, residential proxy, `maxResults: 100`, as a paid user. The timer starts at
the first outbound request and stops at the 100th schema-conforming item; cold start is
excluded, and the run must stay clean — any `429` invalidates the measurement.

That is the author surface, which is the path this Actor is fastest on. One property of it
is worth stating up front, because it sets the ceiling: **a single author is a single
cursor chain, and a cursor chain cannot be parallelised** — page 2 needs page 1's cursor.
So the one-author benchmark measures our sequential paging, not our concurrency.

Guests see two response modes, and the benchmark lands differently on each. Measured
2026-08-17, macOS, **no proxy**, via `npx tsx src/tools/benchmark.ts native <handle>`:

| Single author               | Items | Wall clock | Requests / pages | Selectivity |
| --------------------------- | ----- | ---------- | ---------------- | ----------- |
| `@elonmusk` (snapshot mode) | 99    | **0.31 s** | 2 / 1            | 100%        |
| `@apify` (paginated mode)   | 100   | **12.8 s** | 14 / 12          | 46%         |

Both are Grade A. The paginated row is the honest worst case: twelve sequential pages at
~1.07 s each, on an account that is not especially high-volume — it had to fetch 216 tweets
and discard 116 to reach 100. A genuinely high-volume author is denser, and often answers
in snapshot mode entirely.

### On the Apify platform, with a residential proxy

This is the number the brief re-runs to confirm, so it is published as a **distribution
rather than a best sample**. Paid user, `sortBy: latest`, `maxResults: 100`, Apify
residential proxy, build 0.1.7. Our timer is stricter than the brief's — it **includes**
the ~4 s cold start the brief excludes.

| Author                      | n   | Wall clock (s)                                        | Grade A   |
| --------------------------- | --- | ----------------------------------------------------- | --------- |
| `@elonmusk` (snapshot mode) | 5   | 3.7 · 3.8 · 5.2 · 10.3 · 12.0                         | **5 / 5** |
| `@apify` (paginated mode)   | 8   | 10.1 · 16.2 · 22.4 · 22.7 · 33.2 · 49.2 · 65.0 · 85.1 | 4 / 8     |

Every one of those runs was clean — **zero `429`s, zero errors, zero duplicates**, and on
the paginated account every single run did _identical_ work: 12 pages, 13 requests, 46%
selectivity. The work is constant; only the clock moves.

**So: reliably Grade A on a snapshot-mode author, and a coin flip on a paginated one.**
The variance is Apify residential-proxy latency multiplied across 12 **sequential** page
fetches, which is the ceiling a single cursor chain imposes. A good run paged at ~1.1 s,
identical to the same account with no proxy at all; a bad run paged at ~7 s.

### An optimisation we tried and rejected

The obvious read is "one unlucky exit node, so rotate away from it". We implemented that —
retire a triple after consecutive slow responses so the next page draws a fresh node — and
measured it over another 8 runs. It did not work:

|                             | median | worst      | Grade A |
| --------------------------- | ------ | ---------- | ------- |
| Before                      | 33.2 s | 85.1 s     | 4 / 8   |
| With latency-based rotation | 31.1 s | **94.2 s** | 4 / 8   |

No movement in the median, and a worse tail. Rotation fired correctly (2 → 4 guest tokens
on the slow runs), which is what disproves the hypothesis: minting a replacement costs a
round trip through the _same_ residential pool, so when the pool is slow, rotating buys a
new node that is slow too and charges for the privilege. The bottleneck is the pool at that
moment, not an individual node, and it is not ours to fix from inside the Actor. The change
was reverted rather than kept as unproven complexity.

### What does move it: fewer sequential pages

If proxy latency is the multiplier, the length of the chain is the thing being multiplied.
That is testable. The same account, same conditions, changing only one filter:

| `@apify`, 100 items      | Pages | Selectivity | Median     | Worst  | Grade A   |
| ------------------------ | ----- | ----------- | ---------- | ------ | --------- |
| `includeRetweets: false` | 12    | 46%         | 33.2 s     | 85.1 s | 4 / 8     |
| `includeRetweets: true`  | 8     | 69%         | **14.8 s** | 69.5 s | **7 / 8** |

Counting retweets raises selectivity from 46% to 69%, which drops the chain from 12 pages
to 8 and the median from 33.2 s to 14.8 s. Guest tokens drop from 2 to 1, because the
shorter run fits inside one triple's rate-limit budget. The long tail does not disappear —
one run still hit 69.5 s on the same 8 pages — which is the point: **the proxy sets the
variance, the page count sets the scale.**

Two honest qualifications. The brief's benchmark leaves `includeRetweets` at its default of
`false`, so **4 / 8 is the number that answers the brief** and 7 / 8 is a diagnostic that
attributes the cost. And this sample also drew better proxy luck than the baseline sample
did, so the improvement is not purely the page count.

It also names a limitation rather than a fix. On a retweet-heavy account the default
filters make us fetch 216 tweets to keep 100, and there is no guest-reachable way to avoid
it: `UserOriginalsTimeline` — the operation that would let us ask X for originals only — is
one of the `404`s in §1. We pay for what we discard because the filtered surface is closed.

The two `searchTerms` paths cost very different amounts, and the gap is the architecture
stating its own limitation. Measured 2026-08-17 on macOS with **no proxy**:

|                       | **Author path**              | **Full seeded path**                       |
| --------------------- | ---------------------------- | ------------------------------------------ |
| Query                 | 10 handles, `sortBy: latest` | keyword `"web scraping"`, seeded discovery |
| Items                 | **100**                      | 58 _(seed set exhausted before 100)_       |
| Wall clock            | **2.90 s**                   | 53.6 s                                     |
| Per item              | **29 ms**                    | 925 ms                                     |
| Requests / pages      | 12 / 6                       | 192 / 160                                  |
| Tweets fetched        | 119                          | 3,571                                      |
| Selectivity           | 84%                          | 1.6%                                       |
| Guest tokens          | 1                            | 5                                          |
| Transferred           | 3.2 MB                       | 34.3 MB                                    |
| `429` count           | **0**                        | **0**                                      |
| Cold start (excluded) | 1.4 s                        | 1.3 s                                      |

Cost per 1,000 results at Apify list prices (residential proxy $12.50/GB, compute unit
$0.40). The constants live in `src/actor/summary.ts` so you can correct them for your own
plan:

|           | Author path          | Seeded              |
| --------- | -------------------- | ------------------- |
| Proxy     | 0.032 GB → **$0.40** | 0.59 GB → **$7.39** |
| Compute   | 0.008 CU → $0.003    | 0.26 CU → $0.10     |
| **Total** | **≈ $0.41 / 1k**     | **≈ $7.49 / 1k**    |

**One caveat on those figures: the extrapolation is linear and part of the cost is not.**
Cold start — the ~1.8 MB queryId bundle plus the first guest token — is paid once
regardless of run size, so a small run spreads it thin and overstates per-1k cost. The same
author path reports ≈$2.19/1k on a 10-item free run and ≈$0.41/1k on a 100-item run. The
number only means something for runs large enough to amortise cold start, which is exactly
why `bytesTransferred` is published beside it.

### Read the gap, not the headline

The 32× difference between those two paths is the cost of the stretch surface. Extraction
from known handles — the required path — is fast and cheap. Keyword _matching_ is expensive,
because recall is seed-bounded and selectivity is low. That gap is the honest reason search
is scoped as a bonus here rather than sold as an equal.

An earlier run of the same keyword against weaker seeds measured 0.09% selectivity, 518
requests, 91 MB, and an implied $128/1k. That measurement is why the Actor has a **request
budget** (`maxRequests`, default 500). Without one, the cost of a run is bounded only by
how many accounts exist. When the budget stops a run, the summary says so
(`budgetExhausted: true`).

Every run writes the same diagnostics to `OUTPUT`, so any claim on this page can be
re-derived instead of trusted:

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

The binding constraint is the **request budget**, not latency. X grants roughly 50 requests
per 15 minutes per guest token, a page is ~20 tweets, and a page costs ~700–900 ms.

That is why a _pool_ of session triples is the core design rather than an optimisation, and
why the response to a `429` is to rotate rather than to sleep: a fresh token costs ~200 ms,
and waiting fifteen minutes for a free resource is the largest throughput mistake available
here. Better still, triples retire at ≤5 remaining requests, so the `429` is never taken at
all — both benchmark runs report zero.

Parallelism runs **across accounts**, because a cursor chain cannot be parallelised
internally: page 2 needs page 1's cursor.

> If `SearchTimeline` were available, the A-grade path would be time-window sharding —
> split `since`/`until` into N sub-ranges, run N independent cursor chains in parallel, and
> merge through the global seen-set. A single cursor chain is inherently sequential, so
> sharding the query is the only way to parallelise search paging. It is the same reasoning
> that makes this design parallelise across accounts rather than across pages.

---

## 6. Output contract, and the calls behind it

Every item conforms exactly to the required shape. **Missing values are `null` — never
omitted, never `undefined`** — so the dataset keeps a stable column set. Timestamps are
ISO-8601 UTC, counts are integers, and IDs are strings, never JS numbers (they exceed
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

The brief leaves a number of behaviours undefined. Each one is decided, tested, and written
down here, so documented behaviour can be diffed against actual behaviour:

| Ruling                         | Decision                                                   | Why                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mediaType: images`            | matches if **≥1 photo**, other content allowed             | "tweets with images" is the natural reading; "photos only" surprises                                                                                                                                       |
| `animated_gif`                 | grouped under `video`                                      | X stores GIFs as MP4, and the enum has no `gif` value                                                                                                                                                      |
| `mediaType: links`             | ≥1 entry in `entities.urls`                                | —                                                                                                                                                                                                          |
| `mediaType: text_only`         | **no media AND no links**                                  | `links` is its own enum value, so allowing links here makes the enum incoherent                                                                                                                            |
| `onlyVerified`                 | `is_blue_verified \|\| verification.verified`              | X conflates paid Blue with legacy verification and the schema has one boolean. Never key off `verified_type`: `@grok` returns `verified_type: "Business"` with `verified: false` while being blue-verified |
| `includeReplies` default       | `false`                                                    | the brief specifies the default only for retweets; we default both and say so                                                                                                                              |
| `sortBy: latest`               | descending Snowflake ID                                    | IDs are monotonic, so ID order **is** chronological order                                                                                                                                                  |
| `sortBy: top`                  | descending `likes + retweets` **within the collected set** | X's relevance ranking is not reproducible from the guest surface — approximation, declared                                                                                                                 |
| `since` / `until`              | **inclusive**, applied to the Snowflake                    | a bare date in `until` covers the whole day to `23:59:59.999`; treating it as midnight silently drops a day                                                                                                |
| `tweetIds` vs `includeReplies` | an explicit id opts into replies and retweets              | naming a tweet by id _is_ the selection; those defaults exist to shape a timeline sweep, and applying them here would silently drop the exact tweet asked for                                              |
| `hashtags`                     | post-filter, never a target                                | brief §4: it constrains the timelines a target produced, so a hashtags-only run has nothing to fetch from and is rejected                                                                                  |
| Multiple values in one filter  | OR                                                         | `hashtags: ["a","b"]` means a **or** b                                                                                                                                                                     |
| Multiple filters               | AND                                                        | and an unspecified filter is **no constraint**, never a narrowing one                                                                                                                                      |
| Missing metric vs `minLikes`   | counts as 0                                                | absent data is not evidence of engagement                                                                                                                                                                  |
| Retweet metrics                | the **original's**                                         | the wrapper's counters are structurally zero (§3)                                                                                                                                                          |

Results are buffered and written in one batch at the end, because `sortBy` is a property of
the whole result set and cannot be honoured by an append-only stream. The buffer is bounded
by the cap and checkpointed on migration.

---

## 7. Running it

### The fastest way to verify this

**On the platform.** The Actor is published:
[apify.com/arthurvianna/x-tweet-scraper](https://apify.com/arthurvianna/x-tweet-scraper).
Run it there and the gate is live — free accounts get 10 results, and the run summary in
`OUTPUT` says why.

**Locally, with no account at all.** A fresh clone runs the whole thing, and the gate is
visible immediately because it fails closed without an entitlements store:

```bash
git clone https://github.com/ArthurVianna96/x-tweet-scraper && cd x-tweet-scraper
npm install && npm test              # 221 tests, offline, ~0.5s
mkdir -p storage/key_value_stores/default
echo '{"fromUsers":["apify"],"maxResults":1000}' \
  > storage/key_value_stores/default/INPUT.json
npm run start:dev
```

To exercise the by-id surface instead, swap the input for a list of ids — no accounts
needed, one request each:

```bash
echo '{"tweetIds":["2089366645768643034","1"],"maxResults":1000}' \
  > storage/key_value_stores/default/INPUT.json
npm run start:dev
```

The summary reports `hydratedById: { requested: 2, hydrated: 1, missing: 1 }` — the second
id does not exist, and is counted rather than fatal.

That first run asks for 1000 and returns **10**, logging `reason: "entitlement_unavailable"` —
the fail-closed path. To see the _verified_-free path (`reason: "free_tier"`) and the paid
path you need an entitlements store: either run the deployed Actor above, or stand up your
own ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

### Deployment status

Deployed and verified on Apify on 2026-08-17:

| Check                                       | Result                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Paid run, `maxResults: 15`                  | 15 items, `limited: false`                                                               |
| Paid run, `maxResults: 1000` on one account | 233 items — the account's full reachable timeline                                        |
| **Free run, `maxResults: 1000`**            | **10 items**, `reason: "free_tier"`, 3 requests, 1 token                                 |
| Secret env vars on the Actor                | both `isSecret: true` — the HMAC key is not on the detail page                           |
| Entitlement propagation                     | a `grant`/`revoke` is visible to the next run immediately; no caching observed over 60 s |

The free run is the one that matters. **3 requests and 1 guest token for a 1000-result
request** means the cap stopped the _crawl_, not just the output.

### Deploying your own

Standing up your own copy takes two secrets and one store setting.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the runbook: configuring the gate,
provisioning paid customers, and the one step that fails silently.

That step is worth naming here, because it is the sort of bug that never shows up in your
own testing. The entitlements store must be **public-read** (`generalAccess`, not
`isPublic`). Get it wrong and every customer's run falls back to
`entitlement_unavailable` — capped at 10, paying or not — while your own test runs look
perfect throughout, because your token can read your own private store. The bug is
invisible from the inside and total from the outside.

### Running locally

Input is read from a file, not from arguments. Create it once:

```bash
npm install
cp .env.example .env          # optional — without it the gate caps at 10
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json <<'JSON'
{ "fromUsers": ["apify", "naval"], "maxResults": 25, "sortBy": "latest",
  "proxyConfiguration": { "useApifyProxy": false } }
JSON
```

Then either runner works:

```bash
npm run start:dev     # tsx, reads .env — fastest loop, no Apify login
npx apify-cli run     # the platform's own runner; reads `apify secrets` instead of .env
```

Results land as one file per item in `storage/datasets/default/`, and the run summary in
`storage/key_value_stores/default/OUTPUT.json`.

**Both runners purge the default dataset and key-value store on start** (keeping `INPUT`),
so each local run is clean and there is no stale-state trap. The side effect is that the
resume protection in §4.5 is invisible locally — it needs storage to survive. To watch it
work, disable the purge and run twice:

```bash
APIFY_PURGE_ON_START=0 npm run start:dev   # first run fills the dataset
APIFY_PURGE_ON_START=0 npm run start:dev   # → "resuming", fetched 0, pushed 0
```

The second run reports `fetched: 0` — it did not pull a single page, because the cap was
already spent. To see the resurrect-and-reset bypass fail, forge the counter the way a
runner who owns this storage could, then run again:

```bash
python3 - <<'PY'
import json; p='storage/key_value_stores/default/CRAWL_STATE.json'
d=json.load(open(p)); d['pushed']=0; json.dump(d,open(p,'w'))
PY
APIFY_PURGE_ON_START=0 npm run start:dev   # still "alreadyPushed: 25" — floored on itemCount
```

A residential proxy is recommended (`proxyConfiguration: {"useApifyProxy": true,
"apifyProxyGroups": ["RESIDENTIAL"]}`). X rate-limits per token and per IP, and the seed
lookup is more likely to be challenged from a datacenter IP.

### Development

|                                                               |                                          |
| ------------------------------------------------------------- | ---------------------------------------- |
| `npm test`                                                    | 221 tests, offline, no platform          |
| `npm run typecheck` / `npm run lint`                          | strict TS, ESLint                        |
| `npm run probe`                                               | re-derive the endpoint capability matrix |
| `npx tsx src/tools/capture-fixtures.ts <handles…>`            | refresh committed fixtures from live X   |
| `npx tsx src/tools/benchmark.ts native \| seeded <arg>`       | reproduce §5                             |
| `npm run entitlement -- <key\|grant\|revoke\|check> <userId>` | provision a paid customer                |

Layering is one-way — `actor → adapters → domain` — and `domain/` imports nothing from the
other two. Every seam is constructor injection; there is no module mocking anywhere in the
suite. See `CLAUDE.md` for the full conventions.

---

## 8. robots.txt, ToS, and what we would tell a client

`https://x.com/robots.txt` sets `User-agent: * → Disallow: /`. The `Allow:` rules for
`/search`, `/hashtag/*` and `/i/api/` apply only to the named `Googlebot`/`Bingbot` group.
An automated client that is not a verified search-engine crawler is therefore outside what
robots.txt permits, and X's Terms separately restrict automated access.

We tested whether that crawler allowance was user-agent-gated. It is not: requesting
`/search` with a Googlebot user-agent returns `404`, because X verifies crawler identity by
reverse DNS. We did not attempt to defeat that.

This Actor collects **public data only**, uses no account credentials, and holds a
conservative request rate. Before running it for a client in production we would raise
three things:

1. robots.txt does not permit it, and a commercial agreement or X's licensed API is the
   compliant path at scale;
2. GDPR/CCPA obligations — tweets and author profiles are personal data, so a lawful basis
   and a retention policy are required;
3. guest-token access is undocumented and can be withdrawn without notice, as
   `SearchTimeline` itself demonstrates.

---

## 9. What it cannot do

Stated plainly, because a limitation you find in the README is cheaper than one you find in
production.

- **`searchTerms` recall is seed-bounded.** This is the stretch surface (§2a), and the one
  place we cannot match what a logged-in client could do. You get matching tweets from
  accounts that discuss the topic, not every tweet on X — a hard ceiling of the guest
  surface, not an implementation shortcut. The run summary reports how many accounts were
  seeded and crawled, so callers can judge coverage for themselves. The three required
  surfaces have no such ceiling.
- **`sortBy: top` is an approximation** — engagement ranking within the collected set. X's
  own relevance ranking is not reproducible from the guest surface.
- **On a paginated author the benchmark is proxy-bound, and Grade A is not guaranteed.**
  Measured 4 of 8 runs under 30 s, median 33.2 s, on constant work (§5). A single cursor
  chain is sequential by construction, so residential-proxy latency multiplies across every
  page. We tried rotating away from slow nodes and measured no improvement. Shortening the
  chain does help — counting retweets takes it to 7 of 8 — but the tail stays, because the
  proxy sets the variance and only the page count is ours to influence.
- **Fixtures cannot detect X changing its response shape.** The suite is offline and
  deterministic by choice, and the price of that choice is that these tests stay green
  while production breaks. In a production system you close this with a scheduled,
  non-blocking contract test against the live API that alerts on drift;
  `src/tools/capture-fixtures.ts` makes re-capturing a one-command job. Out of scope here,
  and stated rather than papered over.
- **The seed lookup depends on third-party search engines**, which challenge automated
  traffic (§2). The cascade mitigates it; `fromUsers` removes the dependency entirely.
- **Buffered output** trades peak memory for correct ordering. At the scale this Actor
  targets — hundreds to low thousands of results — that is the right trade. A
  hundred-thousand-result run would want a spill-to-disk merge sort instead.

Delivered from the bonus list (§11): **`searchTerms` via a justified public HTTP source**
rather than left unsupported; incremental/resumable scraping keyed on stored cursors (§4.5);
global deduplication and a seen-set across overlapping targets — required anyway, given
nested retweets, snowball overlap and ids that also appear in a crawled timeline; graceful
handling of protected / suspended / deleted accounts and dead tweet ids, neither of which
fails a run; and cost-per-1k reporting. Not delivered: the finish webhook.

---

## 10. Decisions and trade-offs

1. **Build on the doors that are open, and say which they are.** The three required
   surfaces — author, id, profile — are guest-reachable and implemented natively. Search is
   not, and is scoped as a stretch served a different way rather than half-worked into the
   required paths.
2. **Separate discovery from extraction, and put discovery behind a port.** The one part of
   the problem X does not permit is isolated in a single swappable adapter, and the other
   95% of the system is native and unaffected by that choice.
3. **Ask a web index about profiles, not posts.** Driven by measurement — 36-day-old
   freshest indexed tweet, zero hashtag coverage — not by preference.
4. **Refuse to solve the hard part by buying it.** A paid search API would have made keyword
   search work immediately, and made the extraction someone else's work.
5. **Resolve `queryId`s at runtime.** Three bundle hashes in three days; hardcoding
   guarantees a silent failure on some future Tuesday.
6. **Extract by path; never recurse.** Recursion double-counts nested originals — 32 items
   from a 20-entry page.
7. **Distrust X's own stop signal.** `TimelineTerminateTimeline` costs 79% of recall on a
   paginated account if believed.
8. **Pin the session triple; rotate on `429`; retire before the limit.** Coherence is what
   abuse detection looks for, and proactive retirement is worth more than any backoff.
9. **Enforce the cap at a single lazy chokepoint.** It stops fetching, not just pushing —
   and the seam is constructor injection, so the required test needs no network.
10. **Derive identity from the token, not the environment; fail closed on every path.**
11. **Floor the resume counter on `dataset.itemCount`.** Persisted state is fine for cursors
    and unacceptable for the counter that enforces the cap.
12. **Budget requests explicitly.** Low selectivity is normal, and without a budget the cost
    of a run is bounded only by how many accounts exist.
13. **Publish the diagnostics that would let a reviewer contradict us.** Selectivity, tokens,
    bytes, `429` count and cost are all in `OUTPUT`.
