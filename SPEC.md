# `x-tweet-scraper` — Implementation Spec

Derived from the Puente Talent · Opus technical assessment, plus empirical
findings measured on 2026-08-14. Every non-obvious decision below records **why**,
not just what — the reasoning is the defensible part in a follow-up interview.

Companion documents:

- `README-data-source.md` — the architecture/data-source README section
- `probe-x-endpoints.mjs` — reproduces the endpoint capability matrix

---

## 0. Grading weights → effort allocation

| Weight | Area                   | Status after spec                           |
| ------ | ---------------------- | ------------------------------------------- |
| 25%    | Free-tier protection   | designed end-to-end (§4)                    |
| 25%    | Browserless extraction | designed; contract fully specified (§2, §3) |
| 15%    | Resilience & scale     | designed (§5)                               |
| 15%    | Code quality           | conventions owned by Arthur                 |
| 10%    | Performance            | measured; methodology defined (§6)          |
| 10%    | Tests & docs           | specified (§8, §9)                          |

Half the grade is two _written arguments_ (free-tier design, extraction
approach). Budget README time accordingly — it is not documentation overhead,
it is the deliverable.

---

## 1. Hard constraints (non-negotiable)

- **No browser engine.** HTTP client only (`got-scraping` / `undici` / native `fetch`).
- **Native Apify Actor**: `INPUT_SCHEMA.json`, Apify SDK v3 (`Actor`), dataset output,
  `proxyConfiguration` honoured from input.
- **TypeScript strict**, no `any` crossing a public boundary.
- **Guest tokens only.** No account credentials, no personal session.
- A run must not hard-crash on a single `429`/`403`.

---

## 2. Data source — what is actually reachable

Measured, reproducible via `probe-x-endpoints.mjs`. Method: call each operation
with empty variables; `404` + zero-length body = gated, `422 GRAPHQL_VALIDATION_FAILED`
= permitted (reached validation).

**5 of 23 operations are available to guests** (was 4; `TrendHistory` opened between
2026-08-14 and 2026-08-17, which is itself the argument for runtime queryId resolution):

| Operation                                               | Access | Role in this Actor                                           |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `UserTweets`                                            | ✅     | **the extraction engine** — complete tweet objects + cursors |
| `UserByScreenName`                                      | ✅     | the **profile surface** — handle → `userId` and §5 `author`  |
| `TweetResultByRestId`                                   | ✅     | the **by-id surface** — `tweetIds`, one request per id       |
| `GenericTimelineById`                                   | ✅     | unused                                                       |
| `TrendHistory`                                          | ✅     | trend metadata only, no tweets — unused                      |
| `SearchTimeline` and all search/explore/trend/graph ops | ❌ 404 | —                                                            |

**Consequence:** free-text _search_ is closed, and the three surfaces §2a requires are
open. Guest access is exactly the surface a logged-out browser renders: one profile, or
one tweet — which is why the required set and the reachable set coincide.

Per §2a, `searchTerms` is a **stretch**, not a requirement. We implement it anyway, through
a public web index that seeds account discovery (§2 of the README), and declare its
seed-bounded recall rather than presenting it as parity with the required surfaces.

**Chosen architecture (D1):** separate **discovery** (which accounts) from
**extraction** (their tweets). One external lookup resolves a topic → candidate
handles at cold start only; everything after is native X.

```
DiscoveryStrategy (port)
 ├─ DirectHandleDiscovery   — fromUsers supplied; zero external calls
 ├─ SeededTopicDiscovery    — one search-engine lookup → handles   [default]
 └─ SearchIndexDiscovery    — measured and rejected; documented, not shipped
        ↓ handles
UserByScreenName → userId
        ↓
UserTweets (cursored, live) ──→ filter ──→ ResultSink ──→ dataset
```

**Critical simplification:** `UserTweets` returns **complete** tweet objects — full
text, all six metrics, entities, media, author. **There is no per-tweet hydration
step.** Cost unit is _one request ≈ 20 tweets_, not one request per tweet.
`TweetResultByRestId` remains in the port for externally-supplied IDs only.

**Seed expansion** is native: one `UserTweets` page yields ~37 distinct handles from
mentions and retweeted authors, at zero extra request cost. Depth-limited (default 1),
because mentions from a topical account are not all topical.

### Runtime queryId resolution

`queryId`s rotate with every X frontend deploy — the bundle hash moved from
`main.e4aca26a.js` → `main.4f5b42da.js` **within one afternoon**. Hardcoding
guarantees breakage.

- Fetch `https://x.com/explore` (NOT `x.com/`, which serves an SSR login wall with
  no app bundle), extract `main.<hash>.js`, parse
  `{queryId,operationName,metadata:{featureSwitches,fieldToggles}}` webpack modules.
- Cache for the run. Refresh once on an unexpected `404` from a known-permitted
  operation, then treat as fatal.

---

## 3. Contracts

### 3.1 Input (§4)

Validated with **zod at the boundary**. Malformed input → clear error, exit non-zero.
Unspecified filter = **no constraint**. Combining filters = **AND**.

| Field                                     | Type              | Ruling                                                             |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `fromUsers`                               | `string[]`        | **target.** handles without `@`; used as discovery seeds directly  |
| `tweetIds`                                | `string[]`        | **target.** numeric ids hydrated one request each                  |
| `searchTerms`                             | `string[]`        | **target (stretch).** keyword match against normalized `text`      |
| `hashtags`                                | `string[]`        | post-filter only; without `#`, matched against `entities.hashtags` |
| `since` / `until`                         | ISO date          | **inclusive**; applied via Snowflake before any fetch              |
| `language`                                | ISO-639-1         | `legacy.lang` (X's own detection)                                  |
| `minLikes` / `minRetweets` / `minReplies` | int               | inclusive floors                                                   |
| `onlyVerified`                            | boolean           | see ruling below                                                   |
| `mediaType`                               | enum              | see rulings below                                                  |
| `includeReplies` / `includeRetweets`      | boolean           | **both default `false`**                                           |
| `sortBy`                                  | `latest` \| `top` | see ruling below                                                   |
| `maxResults`                              | int               | requested cap; subject to §4 gate                                  |
| `proxyConfiguration`                      | object            | standard Apify proxy object                                        |

**At least one of `fromUsers`, `tweetIds`, `searchTerms` is required** (§4). `hashtags` is
**not** a target: it constrains the timelines a target produced, so a hashtags-only run has
nothing to fetch from and is rejected at the boundary.

**Rulings the brief leaves undefined** — each must appear in the README, because a
reviewer will diff documented behaviour against actual behaviour:

| Ruling                          | Decision                                                        | Why                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mediaType: images`             | matches if **≥1 photo**, regardless of other content            | "tweets with images" is the natural reading; "photos only" surprises                                                                                                                                   |
| `animated_gif`                  | grouped under `video`                                           | X stores GIFs as MP4; §4 offers no `gif` value                                                                                                                                                         |
| `mediaType: links`              | ≥1 entry in `entities.urls`                                     | —                                                                                                                                                                                                      |
| `mediaType: text_only`          | **no media AND no links**                                       | `links` is a separate enum value; permitting links in `text_only` makes the enum incoherent                                                                                                            |
| `onlyVerified`                  | `is_blue_verified === true \|\| verification.verified === true` | X conflates paid Blue with legacy verification since 2023; §5's single boolean cannot distinguish. Never key off `verified_type` — `@apify` returns `verified_type: "Business"` with `verified: false` |
| `includeReplies` default        | `false`                                                         | §4 specifies the default only for retweets; we default both to `false` and document the ambiguity                                                                                                      |
| `sortBy: latest`                | descending Snowflake ID                                         | IDs are monotonic → ID order _is_ chronological order                                                                                                                                                  |
| `sortBy: top`                   | descending `likes + retweets` within the collected set          | X's relevance ranking is not reproducible from the guest surface — **declared out of scope**                                                                                                           |
| `tweetIds` vs structure filters | an explicit id opts into replies and retweets                   | naming a tweet by id _is_ the selection; `includeReplies`/`includeRetweets` shape a timeline sweep, and applying their `false` defaults here silently drops the exact tweet requested                  |

**`INPUT_SCHEMA.json`**: do **not** declare `"maximum": 10` on `maxResults`. It would
break paying users, and a limit expressed in the input schema is exactly the
client-side artifact §6 forbids as protection. Document the free cap in the field
`description` so users are not surprised; the server-side gate is the only enforcement.

### 3.2 Output (§5)

Every item conforms exactly. **Missing values are `null` — never omitted, never
`undefined`.** Timestamps ISO-8601 UTC. Counts are integers. IDs are strings.

| §5 field            | Source path                                   | Notes                                            |
| ------------------- | --------------------------------------------- | ------------------------------------------------ |
| `id`                | `result.rest_id`                              | string, never a JS number                        |
| `url`               | `https://x.com/<username>/status/<id>`        | built, not read                                  |
| `text`              | see pipeline below                            |                                                  |
| `lang`              | `legacy.lang`                                 |                                                  |
| `createdAt`         | `legacy.created_at`                           | `"Fri Aug 14 15:38:52 +0000 2026"` → ISO         |
| `conversationId`    | `legacy.conversation_id_str`                  |                                                  |
| `isReply`           | `in_reply_to_status_id_str != null`           | structural                                       |
| `isRetweet`         | `'retweeted_status_result' in legacy`         | structural                                       |
| `isQuote`           | `legacy.is_quote_status === true`             | structural                                       |
| `inReplyToId`       | `legacy.in_reply_to_status_id_str`            |                                                  |
| `quotedTweetId`     | `legacy.quoted_status_id_str`                 |                                                  |
| `author.id`         | `core.user_results.result.rest_id`            |                                                  |
| `author.username`   | `…result.core.screen_name`                    | **not** `legacy.screen_name`                     |
| `author.name`       | `…result.core.name`                           |                                                  |
| `author.verified`   | `is_blue_verified \|\| verification.verified` |                                                  |
| `author.followers`  | `…result.relationship_counts.followers`       | **`legacy.followers_count` no longer exists**    |
| `author.following`  | `…result.relationship_counts.following`       |                                                  |
| `metrics.likes`     | `legacy.favorite_count`                       |                                                  |
| `metrics.retweets`  | `legacy.retweet_count`                        |                                                  |
| `metrics.replies`   | `legacy.reply_count`                          |                                                  |
| `metrics.quotes`    | `legacy.quote_count`                          |                                                  |
| `metrics.bookmarks` | `legacy.bookmark_count`                       |                                                  |
| `metrics.views`     | `result.views.count`                          | **coerce to number** — may arrive as a string    |
| `entities.hashtags` | `entities.hashtags[].text`                    | without `#`                                      |
| `entities.mentions` | `entities.user_mentions[].screen_name`        | without `@`                                      |
| `entities.urls`     | `entities.urls[].expanded_url`                | expanded, not `t.co`                             |
| `entities.media`    | `extended_entities.media[]`                   | `{type, url: media_url_https, thumbnail}`        |
| `source`            | `result.source`, HTML stripped                | `<a …>Twitter Web App</a>` → `"Twitter Web App"` |
| `scrapedAt`         | now, ISO                                      |                                                  |

**The `text` pipeline — order is load-bearing:**

```
1. SELECT SOURCE OBJECT
     isRetweet ? legacy.retweeted_status_result.result : self
2. SELECT TEXT FIELD (within that object)
     note_tweet.note_tweet_results.result.text  ??  legacy.full_text
3. EXPAND t.co → entities[].expanded_url
4. DECODE HTML ENTITIES (&amp; &lt; &gt;)      ← MUST BE LAST
```

Why step 4 is last: `entities.urls[]` carry `indices` — character offsets into the raw
string. Decoding `&amp;` (5 chars) → `&` (1 char) shifts every subsequent offset by
four and invalidates index-based replacement.

Two further traps, both observed:

- **Take entities from the same object as the text.** A retweet's `legacy.entities`
  describe the truncated wrapper, not the original.
- **When using `note_tweet`, entities live at `note_tweet_results.result.entity_set`** —
  not `legacy.entities`.

**Measured evidence for why this matters:** every retweet in the sample had
`legacy.full_text` truncated to exactly 140–144 chars (`"RT @handle: …"`), while the
original carried 279–301. Long-form tweets showed `legacy.full_text` at 297 vs
`note_tweet` at **700**.

**Retweet policy** (§5 has `quotedTweetId` but no retweet equivalent — the schema
does not model retweets, so state the reading explicitly):

- `id`, `url`, `author`, `createdAt` → **the retweet's own** (retweet-as-object)
- `text` → full reconstructed text, **never the 140-char truncation**
- `metrics` → **the original's**, because the retweet wrapper's counts are structurally
  `0` and would make `minLikes` silently drop every retweet

### 3.3 Extraction — by path, never by type

```
data.user.result.timeline.timeline.instructions[]
  └─ type "TimelineAddEntries"
       └─ entries[]
            ├─ content.entryType "TimelineTimelineItem"
            │     └─ content.itemContent.tweet_results.result          ← one tweet
            ├─ content.entryType "TimelineTimelineModule"
            │     └─ content.items[].item.itemContent.tweet_results.result
            └─ content.entryType "TimelineTimelineCursor"
                  └─ cursorType "Bottom" → variables.cursor
```

Take `tweet_results.result` at exactly that depth and **never recurse into it**.
Nested `retweeted_status_result` / `quoted_status_result` are context, not results.
Recursive `__typename === "Tweet"` matching turned a 20-entry page into 32 items in
testing — a duplicate bug §7 explicitly grades.

Also: skip `TimelinePinEntry`. It carries an old pinned tweet that silently corrupts
`sortBy: latest` ordering. `TimelineTerminateTimeline` is the stop signal.

Defensive: unwrap `__typename === "TweetWithVisibilityResults"` → `.tweet`. Not
observed in sampling, but known to occur.

---

## 4. Free-tier gate (25% — the differentiator)

### 4.1 Identity — resolve from the credential, not the claim

```ts
const me = await new ApifyClient({ token: process.env.APIFY_TOKEN }).user('me').get();
const runnerUserId = me.id;
```

**Not** `Actor.getEnv().userId`. Per Apify docs, `APIFY_USER_ID` is _"ID of the user who
started the Actor"_ and `APIFY_TOKEN` is _"API token of the user who started the Actor."_
§6 explicitly names environment variables as untrusted, and the token is strictly
stronger: it is a **credential the authority validates**, not an **unverified claim**.
Self-validating — a forged token is either invalid (→ fail closed → free) or genuinely
another account's (→ correctly returns _their_ entitlement).

### 4.2 Entitlement — a store only we can write

**The trap:** the run's `APIFY_TOKEN` belongs to the _runner_, so `Actor.apifyClient`,
`Actor.getValue()` and the default KV store are all authenticated **as them**. A private
store on our account is unreachable that way.

**Design:** public read-only KV store, keys HMAC'd.

```ts
const key = createHmac('sha256', process.env.ENTITLEMENTS_HMAC_KEY!)
  .update(runnerUserId)
  .digest('hex');
```

- Public store → the runner's own token can read it; no API token needed at read time.
- Authority is **write** access, which stays ours. Public reads cannot change a verdict.
- HMAC'd keys → a world-readable store leaks no customer IDs.
- **Blast radius:** if an Apify API token leaked, an attacker writes to the store and
  grants themselves paid. If the HMAC key leaks, they compute a key in a store that was
  already public. Prefer the credential whose leak costs least.

**`ENTITLEMENTS_HMAC_KEY` must be marked `Secret` in the Apify Console.** Per Apify's
publishing docs, a published Actor's _"source code files and non-secret environment
variables are publicly visible by default."_ A plain env var would publish the key on
the Actor detail page — a total compromise of the authority.

### 4.3 Enforcement — one chokepoint, lazily consumed

```ts
class ResultSink {
  private pushed = 0;
  constructor(private readonly opts: { cap: number; push: (t: Tweet) => Promise<void> }) {}

  /** @returns false when the cap is reached — caller must stop. */
  async push(item: Tweet): Promise<boolean> {
    if (this.pushed >= this.opts.cap) return false; // check…
    this.pushed++; // …and increment, no await between
    await this.opts.push(item);
    return this.pushed < this.opts.cap;
  }
}
```

```ts
for await (const tweet of crawl(seeds)) {
  // lazy: pages cursors on demand
  if (!matches(tweet, filters)) continue;
  if (!(await sink.push(tweet))) break; // unwinds the generator chain
}
```

`break` stops the consumer → stops the crawl → stops cursor paging. A free user with
`maxResults: 1000` fetches ~1 page and exits. This is §6's _"stops fetching and pushing
at 10 regardless of any input"_ — **not** clamping `maxResults` at the top, which §6
explicitly rejects. Clamp too, as an optimisation; the sink is the invariant.

**Concurrency hazard:** with parallel account chains, `pushed++` must sit _above_
`await push(...)`. Any `await` between check and increment reintroduces a race that
lets N workers each pass the check. Swapping those two lines produces an intermittent
bug that passes every test in §8.

### 4.4 Fail-closed

```ts
const isPaid = entitlement?.paid === true; // ✅ undefined → false → free
// const isPaid = entitlement?.paid !== false;  ❌ undefined → true → unlimited
```

Default-deny with `=== true`, never `!== false`. Validate the entitlement response with
zod so `undefined` cannot reach a boolean. Any failure — timeout, unknown user, malformed
response — resolves to free.

### 4.5 State bypass — the counter must not live where the adversary can write

The run's default KV store belongs to the runner and their token can write to it:

```
1. Free run pushes 10, persists { pushed: 10 }.
2. User PUTs { pushed: 0 } to the run's KV record with their own token.
3. User resurrects the run → resumes at 0 → pushes 10 more into the same dataset.
4. Repeat indefinitely.
```

A naive resume that restarts the counter at zero gives 20 on the first resurrect, with
no tampering at all.

**Fix — floor the counter on an authority the user cannot lower:**

```ts
const { itemCount } = await Actor.apifyClient.dataset(datasetId).get();
const pushed = Math.max(persisted.pushed ?? 0, itemCount);
```

They cannot reduce `itemCount` without deleting the results they were trying to
accumulate. Additionally: **re-resolve entitlement on resume**; never cache the
paid/free verdict in runner-writable storage.

Principle: _persisted state is fine for cursors — worst case the user re-scrapes and
pays for it. It is not fine for the counter that enforces the cap._

### 4.6 Transparency

```jsonc
{ "limited": true, "reason": "free_tier",               "cap": 10 }  // verified free
{ "limited": true, "reason": "entitlement_unavailable", "cap": 10 }  // could not verify
```

Same cap, different meaning. The second is the **alertable** condition — it means a
paying customer may be getting capped. Written to `OUTPUT` in the run's KV store and
emitted as a structured log line.

### 4.7 Anti-fork — a README argument, not code

§6 asks only to _"briefly discuss in the README."_ **Do not build anti-fork machinery.**

- **Layer 0 — Distribution.** Production: private repo. _(This submission is public per §9.)_
- **Layer 1 — Platform.** `Settings → Hide source files from Actor detail`, or the Store
  republishes the source regardless of where git lives.
- **Layer 2 — Credential.** HMAC key as a **Secret** env var: absent from repo, absent
  from the public env listing, unreadable via API or Console.
- **Layer 3 — Authority.** The verdict comes from a store only our token can write. A fork
  cannot _impersonate_ a paid user — only _delete the check_.
- **Layer 4 — The honest limit.** Deletion is unpreventable. A _permission_ check asks the
  server a question and can be removed; only a _capability_ the server supplies cannot.
  A capability moat must rest on something **expensive to reproduce or perishable** —
  not merely hidden. Guest tokens are freely mintable and queryIds are freely
  extractable, so this task has no genuine capability moat. The real moat is the Store
  listing, maintained queryId resolution, and operational upkeep.

Close the section by naming the endpoint of that reasoning: `apidojo-io/twitter-scraper-lite`
is a public repo containing **no HTTP calls to X at all** — a thin `apify_client` wrapper
around paid actor `nfp1fpt5gUlBwPcor`. It is perfectly fork-proof because forking it
yields nothing. We deliberately did not go there: the brief asks for a browserless
extractor, not a billing wrapper. **Our gate is fully tamper-proof and explicitly not
fork-proof, and that is the correct trade for this deliverable.**

---

## 5. Resilience (§7)

### 5.1 Session triple

Pin `(guestToken, proxySession, userAgent)` — created together, retired together, using
Apify Proxy `session` IDs for a sticky IP.

**Why pin:** X's abuse detection looks for _coherence_. A real browser is one token, one
IP, one UA for a session. One token arriving from 12 residential IPs in 90 seconds is a
pattern no browser produces. And 50 req/15 min **is the budget X grants** — staying
inside it looks like one person browsing, not evasion.

**What hopping leaks:** the cross-product. Token T on IPs 1–12 _and_ IP 1 serving tokens
A–L makes the whole pool linkable from any single observation. Pinning caps the loss of
any burned triple at 1/N of capacity.

### 5.2 Error taxonomy

| Signal                                     | Action                                   | Rationale                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `429`                                      | **Rotate to a fresh triple immediately** | Minting is free and instant; waiting 15 min when a new token costs ~200 ms is the largest available throughput mistake. Global backoff only when the whole pool is spent. |
| `403` on a permitted op                    | rotate the guest token                   | classic guest-token expiry                                                                                                                                                |
| `404` on a permitted op for a known handle | **terminal, not retryable**              | protected / suspended / deleted account. Log, count, skip, continue (§11 bonus)                                                                                           |
| `5xx`                                      | retry with backoff                       | transient (§7: retryable)                                                                                                                                                 |
| socket timeout                             | retry with backoff                       | transient                                                                                                                                                                 |
| `400` / malformed input                    | fatal                                    | non-recoverable                                                                                                                                                           |

**Proactive budgeting beats reactive backoff.** Every response carries
`x-rate-limit-remaining` and `x-rate-limit-reset` (epoch). Retire a triple at
**≤5 remaining** so a `429` is never taken. Target `429 count = 0` in the run summary.

Backoff: exponential with **full jitter**, bounded retry budget per request (3) and per
run. Graceful degradation — one dead account never fails the run.

### 5.3 Persisted state

`Actor.on('migrating')` + periodic checkpoint. Persist: per-account cursors, the global
seen-set, discovered-but-uncrawled handles, error counters. **The pushed counter is
floored on `dataset.itemCount` (§4.5), never trusted from storage.**

---

## 6. Concurrency & performance (§8)

**Measured:** ~20 tweets/page (`count: 100` is silently ignored), ~1.4 s/page (211 KB),
50 requests/15 min per token, cursors via `cursorType: "Bottom"`.

The binding constraint is the **request budget**, not latency — which is why a _pool_ of
triples is the core design, not an optimisation.

**Parallelism model:** N bounded-concurrency account chains, each an independent cursor
sequence, all feeding one `ResultSink`. Cursor chains cannot be parallelised internally;
parallelising _across accounts_ is the equivalent of time-window sharding a search query.

**Reporting.** §8's benchmark query requires `SearchTimeline` and cannot run. Keep their
**protocol** (timer starts at first outbound request, stops at the 100th
schema-conforming item pushed, cold start excluded, run must stay clean), substitute the
query, declare the substitution. Report two numbers:

1. **Native path** — `fromUsers: [10 handles], sortBy: latest, maxResults: 100`,
   residential proxy. Pure guest-token X. The headline number.
2. **Full D1 path** — keyword → seed resolution → crawl → 100 items.

Publish diagnostics so the grade can be re-derived rather than trusted:
`requests · pages · items collected vs. filtered (selectivity) · tokens consumed ·
429 count (target 0) · wall clock`.

Then the paragraph that turns substitution into evidence:

> If `SearchTimeline` were available, the A-grade path is time-window sharding: split
> `since`/`until` into N sub-ranges, run N independent cursor chains in parallel, merge
> through the global seen-set. A single cursor chain is inherently sequential, so
> sharding the query is the only way to parallelise search paging — the same reason our
> seeded design parallelises across accounts rather than across pages.

---

## 7. Observability (§7)

Structured logs throughout. Final summary written to `OUTPUT` and logged:

```jsonc
{
  "requested": 500,
  "fetched": 340,
  "pushed": 100,
  "limited": false,
  "reason": null,
  "cap": null,
  "seedsResolved": 12,
  "accountsCrawled": 12,
  "pagesFetched": 21,
  "filteredOut": 240,
  "selectivity": 0.29,
  "duplicatesDropped": 18,
  "accountsSkipped": { "protected": 1, "suspended": 0, "notFound": 2 },
  "tokensConsumed": 3,
  "errors": { "429": 0, "5xx": 1, "timeout": 0 },
  "estimatedCostPer1kResults": { "proxyGB": 0.42, "computeUnits": 0.08, "usd": 0.31 },
  "wallClockMs": 27140,
}
```

---

## 8. Tests (§7 — the cap test is _required_)

**Seam: constructor injection (Shape A).** `ResultSink` takes `{ cap, push }`;
the entitlement resolver takes a fetcher. No platform, no network in unit tests.

| Suite                          | Cases                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Free-tier cap** _(required)_ | free + `maxResults: 1000` → **exactly 10**; paid + `maxResults: 1000` → 1000; `sink.push` returns `false` at the cap; **crawl stops** (assert the discovery generator is not pulled again); counter survives a simulated migration (persist → restore → pushes 0 more); entitlement lookup throws → free; entitlement returns `undefined` → free |
| **Normalizer**                 | retweet → full text not the 140-char truncation; long-form → `note_tweet` text not `legacy.full_text`; `&amp;` decoded; `t.co` expanded; `author.followers` from `relationship_counts`; `views` string → number; every absent field is `null`, never `undefined`; nested retweeted/quoted originals are **not** emitted as separate items        |
| **Filter logic**               | each of the 13 filters in isolation; AND-combination; unspecified = no constraint; `mediaType` rulings from §3.1; `text_only` excludes links; `onlyVerified` with `verified_type: "Business"` + `verified: false` → not verified; Snowflake `since`/`until` boundaries are inclusive                                                             |

**Fixtures**: committed real payloads (retweet, long-form, quote, media, reply,
protected-account 404). Deterministic and offline.

**Documented limitation** (README, not code): fixtures cannot detect X changing its
response shape — tests stay green while production breaks. In a production system this
is closed with a scheduled non-blocking contract test against the live API that alerts
on drift. Out of scope here.

---

## 9. Deliverables (§9)

- Public GitHub repo: source, `INPUT_SCHEMA.json`, `.actor/`, `Dockerfile`, tests
- Deployed Actor on Apify, runnable by the reviewer
- `scripts/probe-x-endpoints.mjs` — reproduces §2 in ~20 s, no credentials
- README: architecture & data flow · the no-browser HTTP approach · free-tier design +
  anti-bypass/anti-fork · local + Apify run instructions · **measured §8 numbers with
  stated methodology** · ToS/robots · known limitations
- Short decisions/trade-offs note (README section or ≤5 min Loom)

### In scope (§11 bonuses)

- **Dedup + global seen-set** — required anyway by nested retweets and snowball overlap
- **Protected / suspended / deleted account handling** — falls out of the 404-is-terminal rule
- **Cost per 1k results** — requests, pages and tokens are already measured

### Explicitly out of scope — stated plainly in the README (§12 rewards this)

- **`sortBy: top`** is approximated by engagement ranking within the collected set;
  X's relevance ranking is not reproducible from the guest surface.
- **`searchTerms` recall is seed-bounded** — tweets from accounts that discuss the topic,
  not every tweet on X. A hard ceiling of the guest surface, and the reason §2a scopes
  search as a stretch. The three required surfaces have no such ceiling.
- **`toUsers`/`mentioning` are not implemented** — brief v2 removed them from the input
  schema, and they were only ever there to satisfy that row.
- **Live contract testing** against X is not automated (§8).
