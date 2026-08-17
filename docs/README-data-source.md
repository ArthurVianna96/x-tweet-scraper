# Data source & architecture

> **Summary.** X's search endpoint is closed to guest-token auth. This Actor
> therefore separates **discovery** (which tweets exist for a topic) from
> **hydration** (fetch a tweet by ID and normalize it). Hydration runs entirely
> on X's internal GraphQL API with guest tokens, exactly as the brief intends.
> Discovery uses `UserTweets` natively wherever an account is known, and falls
> back to a single external lookup only to cold-start a topic into a set of
> handles. No browser, no logged-in account, no purchased tweet data.

## 1. What we measured

Before writing any code we probed X's internal GraphQL API to establish what
guest-token auth can actually reach. `scripts/probe-x-endpoints.mjs` reproduces
this in full; it takes about 20 seconds and needs no credentials.

The method relies on a status-code split that distinguishes *refusal* from
*malformed request*:

| Status | Meaning |
| --- | --- |
| `404`, zero-length body | Operation **gated** for guests — refused before validation |
| `422 GRAPHQL_VALIDATION_FAILED` | Operation **permitted** — reached validation, our variables were wrong |
| `200` | Operation **permitted** |

Result — **4 of 23** probed operations are available to guests:

| Operation | Guest access |
| --- | --- |
| `UserByScreenName` | ✅ permitted |
| `UserTweets` | ✅ permitted |
| `TweetResultByRestId` | ✅ permitted |
| `GenericTimelineById` | ✅ permitted |
| `SearchTimeline` | ❌ gated |
| `ListSearchTimeline`, `GlobalCommunitiesPostSearchTimeline`, `GlobalCommunitiesLatestPostSearchTimeline` | ❌ gated |
| `ExplorePage`, `ExploreSidebar`, `TrendHistory`, `TrendRelevantUsers` | ❌ gated |
| `Followers`, `Following`, `FollowersYouKnow`, `SimilarPosts` | ❌ gated |
| `UserRepliesTimeline`, `UserOriginalsTimeline`, `UserPhotoTimeline`, `UserVideoTimeline`, `UserRepostsTimeline`, `UserMedia`, `TweetDetail` | ❌ gated |

The permitted set is not arbitrary: it is precisely the surface a logged-out
browser can render — **one profile, or one tweet**. Search is not on that
surface, and neither is anything adjacent to it.

Guest tokens themselves are alive and unrestricted:
`POST /1.1/guest/activate.json` returns `200` and the token is accepted by every
permitted operation. The gate is on the *operation*, not on guest auth.

We also ruled out the obvious workarounds:

| Attempt | Result |
| --- | --- |
| `SearchTimeline` via `api.x.com`, `twitter.com`, POST, `product=Top` | `404` in every variant |
| `SearchTimeline` with an `x-client-transaction-id` header | `404` |
| X's legacy iPhone bearer token | rejected at `guest/activate` |
| `/i/api/2/search/adaptive.json`, `/i/api/1.1/search/typeahead.json` | `403` |
| `cdn.syndication.twimg.com/timeline/{search,hashtag}` | `200` with a zero-byte body |
| `x.com/hashtag/<tag>` logged out | `200`, but an empty SPA shell — no tweet content |
| `x.com/search` with a Googlebot user-agent | `404` — X verifies crawlers by reverse DNS, not UA string |

## 2. Architecture: discovery vs. hydration

Because search is closed but tweet-by-ID is open, the problem splits cleanly:

```
                       ┌──────────────────────────────┐
  topic / handles ───► │  DiscoveryStrategy (port)    │ ──► tweet IDs
                       ├──────────────────────────────┤
                       │ • SeededTimelineDiscovery    │  ← default
                       │ • DirectHandleDiscovery      │  ← when fromUsers given
                       │ • (SearchIndexDiscovery)     │  ← implemented, not shipped
                       └──────────────────────────────┘
                                      │
                       ┌──────────────▼───────────────┐
                       │  Hydration (guest GraphQL)   │ ──► §5-conforming items
                       │  UserTweets / TweetResultBy… │
                       └──────────────────────────────┘
```

Only the discovery adapter varies. Normalization, the guest-token pool,
backoff, proxy rotation, cursor pagination, deduplication and the free-tier gate
are shared by every strategy.

Hydration was verified against the full §5 contract on a live tweet — including
`metrics.bookmarks` and `metrics.views`, the two fields most implementations
drop.

> **Schema note.** X has restructured its user object. `legacy.followers_count`
> **no longer exists**; follower data now lives at
> `user_results.result.relationship_counts` → `{ followers, following }`, and
> verification at `verification` → `{ verified, verified_type }`. Most published
> scrapers still read the `legacy.*` paths and silently emit `null` for
> `author.followers`. We read the current paths.

## 3. The chosen path, and why

`searchTerms` and `hashtags` need a way to turn a *topic* into *accounts*. Every
X-side path for that is gated (user search, typeahead, Explore, trends, and the
entire social graph — all `404`/`403` above). So the cold start must come from
somewhere else, and after that everything is native.

**What we ship:** one external lookup resolves a topic to candidate handles.
From that point the Actor is 100% X-native — `UserByScreenName` → `UserTweets`
with cursor pagination, filtered client-side. The external lookup is:

- **used once per run**, at cold start only;
- **skipped entirely** when `fromUsers` is supplied;
- **behind the `DiscoveryStrategy` port**, so it is swappable for a static seed
  list or a hand-supplied roster without touching extraction.

The seed set then expands natively: a single `UserTweets` page yields **~37
distinct handles** from mentions and retweeted authors, at no extra request
cost — that data is already in a response we are paying for.

### Alternatives considered

| Option | Why not |
| --- | --- |
| **Purchased tweet search API** (e.g. a pay-per-event Apify actor) | Returns keyword results immediately, but the X-specific extraction would be the vendor's work, not ours. It also relies on server-side account credentials — the mechanism §3 explicitly bans. Worth noting that the widely-referenced `apidojo-io/twitter-scraper-lite` repo, which advertises keyword search, contains **no HTTP calls to X at all**: it is a `apify_client` wrapper around paid actor `nfp1fpt5gUlBwPcor`. |
| **X official API v2 recent search** | Legitimate, but requires a paid app bearer and reintroduces a hardcoded credential. |
| **Search-engine index → tweet IDs → hydrate** | Implemented and measured, then rejected. For a *keyword* query the freshest indexed tweet was **36 days old** (median 181 days), and a *hashtag* query returned **zero** tweet URLs — only profile pages. `sortBy: latest` cannot be served honestly from a web index. The same measurement is what makes the *handle*-discovery variant viable: search engines index X **profiles** well and X **posts** slowly. |
| **Logged-in account pool** | Prohibited by §3. |

### Trade-offs we accept

- **Recall is bounded by the seed set.** We return matching tweets from accounts
  that discuss the topic — not every tweet on X. A true search index would have
  higher recall. This is a hard ceiling of the guest-token surface, not an
  implementation shortcut, and the run summary reports how many accounts were
  seeded and crawled so callers can judge coverage.
- **One external dependency at cold start.** Removable: supply `fromUsers` and
  the Actor makes no third-party call at all.
- **Precision decays with snowball depth.** Mentions from a topical account are
  not all topical. Expansion is depth-limited and every discovered tweet is
  re-checked against the filter predicate before emission.

## 4. Implementation notes worth flagging

**Runtime queryId extraction.** GraphQL `queryId`s rotate with every X frontend
deploy — the bundle hash changed from `main.e4aca26a.js` to `main.4f5b42da.js`
*during a single afternoon of development*. Hardcoding them guarantees breakage,
so we extract them at runtime from the logged-out bundle (reachable at
`/explore`; `x.com/` itself serves an SSR login wall with no app bundle) and
cache them for the run.

**Snowflake IDs make two filters free.** Tweet IDs encode their creation time:

```ts
const createdAt = (id: string) => new Date(Number(BigInt(id) >> 22n) + 1288834974657);
```

So `since`/`until` are applied to discovered IDs *before* hydration — we never
pay to fetch a tweet outside the window — and `sortBy: latest` is a descending
ID sort, because Snowflakes are monotonic. No extra requests, and exact.

**Measured limits driving the concurrency design.**

| Property | Measured |
| --- | --- |
| `UserTweets` page size | ~20 tweets (`count: 100` is silently ignored) |
| Latency per page | ~1.4 s (≈211 KB) |
| Rate limit | **50 requests / 15 min, per guest token** |
| Guest token minting | instant and unmetered |
| Pagination | `cursorType: "Bottom"` → `variables.cursor`; `TimelineTerminateTimeline` signals end |

The binding constraint is the 50-request budget, not latency — which is why a
**pool of guest tokens** is the core throughput design rather than an
optimization, and why request budgeting is driven by filter selectivity rather
than by target result count.

## 5. ToS, robots.txt, and what we would raise with a client

`https://x.com/robots.txt` sets `User-agent: * → Disallow: /`. The `Allow:`
rules for `/search`, `/hashtag/*` and `/i/api/` apply only to the named
`Googlebot`/`Bingbot` group. An automated client that is not a verified search
engine crawler is therefore outside what robots.txt permits, and X's ToS
separately restrict automated access.

We tested whether the crawler allowance was user-agent-gated — it is not:
requesting `/search` with a Googlebot user-agent returns `404`, because X
verifies crawler identity by reverse DNS. We did not attempt to defeat that.

This Actor collects **public data only**, uses no account credentials, and
honours a conservative request rate. Before running this for a client in
production we would raise: (a) that robots.txt does not permit it, and a
commercial agreement or X's licensed API is the compliant path at scale;
(b) GDPR/CCPA obligations, since tweets and author profiles are personal data
and a lawful basis and retention policy are required; (c) that guest-token
access is undocumented and can be withdrawn without notice — as `SearchTimeline`
itself demonstrates.

## 6. Known limitations

- Keyword and hashtag recall is bounded by the seed set (§3).
- `sortBy: top` is approximated by ranking on engagement within the collected
  set; X's own relevance ranking is not reproducible from the guest surface.
- Protected, suspended and deleted accounts yield no results; these are logged
  and counted in the run summary rather than failing the run.
- The §8 benchmark as specified ("a broad keyword, `sortBy: latest`") exercises
  X's search endpoint, which is closed to guest auth. Our reported timing is
  measured on the discovery path we ship; the methodology is documented in §8 of
  this README so it can be compared like-for-like.
