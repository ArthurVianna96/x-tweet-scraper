# Data-source measurements

Raw evidence behind the architecture. The argument itself lives in
[`README.md`](../README.md) §1–§3; this file is the appendix that keeps the _numbers_ and
their dates, so drift is visible rather than assumed.

Everything here is reproducible with `npm run probe` (≈20 s, no credentials).

---

## 1. Method

`scripts/probe-x-endpoints.mjs` mints a guest token, pulls the logged-out SPA bundle from
`x.com/explore`, extracts every `{queryId, operationName}` pair, and calls each target
operation with **empty variables**. The classification rests on a status-code split that
separates _refusal_ from _malformed request_:

| Status                          | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `404`, zero-length body         | **gated** — X refused the operation for this auth level, before validation |
| `422 GRAPHQL_VALIDATION_FAILED` | **permitted** — the request reached validation; our variables were wrong   |
| `200`                           | **permitted**                                                              |

The 404/422 split is load-bearing: a `404` here is not a bad path or a stale `queryId`,
because operations that _are_ permitted return a descriptive `422` on the same token in
the same second.

---

## 2. Capability matrix, and how it drifted

| Operation                                                                                                                    | 2026-08-14   | 2026-08-17                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- |
| `UserByScreenName`                                                                                                           | ✅ permitted | ✅ permitted               |
| `UserTweets`                                                                                                                 | ✅ permitted | ✅ permitted               |
| `TweetResultByRestId`                                                                                                        | ✅ permitted | ✅ permitted               |
| `GenericTimelineById`                                                                                                        | ✅ permitted | ✅ permitted               |
| `TrendHistory`                                                                                                               | ❌ gated     | **✅ permitted** ← changed |
| `SearchTimeline`                                                                                                             | ❌ gated     | ❌ gated                   |
| `ListSearchTimeline`                                                                                                         | ❌ gated     | ❌ gated                   |
| `GlobalCommunitiesPostSearchTimeline`                                                                                        | ❌ gated     | ❌ gated                   |
| `GlobalCommunitiesLatestPostSearchTimeline`                                                                                  | ❌ gated     | ❌ gated                   |
| `ExplorePage`, `ExploreSidebar`                                                                                              | ❌ gated     | ❌ gated                   |
| `TrendRelevantUsers`                                                                                                         | ❌ gated     | ❌ gated                   |
| `Followers`, `Following`, `FollowersYouKnow`, `SimilarPosts`                                                                 | ❌ gated     | ❌ gated                   |
| `UserRepliesTimeline`, `UserOriginalsTimeline`, `UserPhotoTimeline`, `UserVideoTimeline`, `UserRepostsTimeline`, `UserMedia` | ❌ gated     | ❌ gated                   |
| `TweetDetail`                                                                                                                | ❌ gated     | ❌ gated                   |

**4 of 23 → 5 of 23 in three days.** `TrendHistory` carries trend metadata, not tweets, so
it does not reopen search — but the drift is the argument for runtime `queryId` resolution
in one line. The bundle hash moved three times over the same period:
`main.e4aca26a.js` → `main.4f5b42da.js` → `main.b07c4c6a.js`.

Guest tokens themselves are healthy throughout: `POST /1.1/guest/activate.json` returns
`200` and the token is accepted by every permitted operation. The gate is on the
_operation_, not on guest auth.

---

## 3. Workarounds ruled out

| Attempt                                                              | Result                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `SearchTimeline` via `api.x.com`, `twitter.com`, POST, `product=Top` | `404` in every variant                                    |
| `SearchTimeline` with an `x-client-transaction-id` header            | `404`                                                     |
| X's legacy iPhone bearer token                                       | rejected at `guest/activate`                              |
| `/i/api/2/search/adaptive.json`, `/i/api/1.1/search/typeahead.json`  | `403`                                                     |
| `cdn.syndication.twimg.com/timeline/{search,hashtag}`                | `200` with a zero-byte body                               |
| `x.com/hashtag/<tag>` logged out                                     | `200`, empty SPA shell — no tweet content                 |
| `x.com/search` with a Googlebot user-agent                           | `404` — X verifies crawlers by reverse DNS, not UA string |

---

## 4. Why the search-index route was rejected

Measured before it was discarded:

| Query type | Freshest indexed tweet | Median age | Tweet URLs returned           |
| ---------- | ---------------------- | ---------- | ----------------------------- |
| keyword    | **36 days**            | 181 days   | some                          |
| hashtag    | —                      | —          | **zero** (profile pages only) |

`sortBy: latest` cannot be served honestly from a web index. The same measurement is what
makes _handle_ discovery viable: search engines index X **profiles** well and X **posts**
slowly, so the shipped design asks them only "who talks about this".

---

## 5. Timeline behaviour, measured 2026-08-17

Guest `UserTweets` has two response modes, and the pagination stop signal is unreliable:

| Account          | Page 0                   | `TimelineTerminateTimeline` | Following the bottom cursor anyway     |
| ---------------- | ------------------------ | --------------------------- | -------------------------------------- |
| `@apify`         | 19 tweets, cursor issued | `direction: "TopAndBottom"` | 5 pages, **92 unique tweets, all new** |
| `@naval`         | 98 tweets, no cursor     | `direction: "TopAndBottom"` | n/a                                    |
| `@elonmusk`      | 99 tweets, no cursor     | `direction: "TopAndBottom"` | n/a                                    |
| `@paulg`, `@dhh` | 100 tweets, no cursor    | —                           | n/a                                    |

Snapshot-mode pages are **not** in chronological order; paginated-mode pages are. Treating
the terminate instruction as authoritative truncates `@apify` from 92 tweets to 19 with no
error anywhere in the logs — see `README.md` §3 and `src/adapters/x/timeline.ts`.

Throughput properties driving the concurrency design:

| Property            | Measured                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| Page size           | ~17–20 tweets paginated (`count: 100` is ignored); 98–100 in snapshot mode |
| Latency per page    | ~0.7–0.9 s (~180 KB)                                                       |
| Rate limit          | ~50 requests / 15 min, per guest token                                     |
| Guest token minting | instant and unmetered                                                      |
| Pagination          | `cursorType: "Bottom"` → `variables.cursor`                                |
| queryId bundle      | ~1.8 MB, once per run                                                      |

---

## 6. Schema notes

X has restructured its user object, and most published scrapers have not followed:

- `legacy.followers_count` **no longer exists** — follower data is at
  `user_results.result.relationship_counts` → `{ followers, following }`;
- `screen_name` and `name` are under `core`, not `legacy`;
- verification is `{ is_blue_verified, verification: { verified, verified_type } }`, and
  `verified_type: "Business"` coexists with `verified: false`;
- `views.count` arrives as a **string** while every sibling metric is a number.
