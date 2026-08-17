#!/usr/bin/env node
/**
 * probe-x-endpoints.mjs
 *
 * Determines, empirically, which of X's internal GraphQL operations are
 * reachable with guest-token auth (no account, no browser, no cookies).
 *
 * Method
 * ------
 * 1. Mint a guest token via POST /1.1/guest/activate.json using X's public
 *    web bearer (embedded in x.com's own JS bundle; not a secret).
 * 2. Pull the logged-out SPA bundle from /explore and extract every
 *    { queryId, operationName } pair, plus each operation's featureSwitches.
 * 3. Call each operation with EMPTY variables and classify the status:
 *
 *      404 -> operation is GATED for guests (refused before validation)
 *      422 -> operation is PERMITTED (reached GraphQL validation)
 *      200 -> operation is PERMITTED (and tolerated empty variables)
 *
 *    The 404/422 split is the load-bearing signal: a 404 with a zero-length
 *    body is X refusing the operation for this auth level, NOT a bad path or
 *    a stale queryId. Operations that ARE permitted return a descriptive
 *    422 GRAPHQL_VALIDATION_FAILED on the same token in the same second.
 *
 * Usage: node probe-x-endpoints.mjs
 * Requires Node 18+ (global fetch). No dependencies.
 */

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** Operations worth classifying. Everything search-shaped, plus known-good controls. */
const TARGETS = [
  // --- discovery / search surface ---
  'SearchTimeline',
  'ListSearchTimeline',
  'GlobalCommunitiesPostSearchTimeline',
  'GlobalCommunitiesLatestPostSearchTimeline',
  'ExplorePage',
  'ExploreSidebar',
  'TrendHistory',
  'TrendRelevantUsers',
  // --- social graph (would enable native seed expansion) ---
  'Followers',
  'Following',
  'FollowersYouKnow',
  'SimilarPosts',
  // --- narrower user timelines ---
  'UserRepliesTimeline',
  'UserOriginalsTimeline',
  'UserPhotoTimeline',
  'UserVideoTimeline',
  'UserRepostsTimeline',
  'UserMedia',
  'TweetDetail',
  // --- controls: expected to be permitted ---
  'UserByScreenName',
  'UserTweets',
  'TweetResultByRestId',
  'GenericTimelineById',
];

async function mintGuestToken() {
  const res = await fetch('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`guest/activate failed: HTTP ${res.status}`);
  const { guest_token } = await res.json();
  return guest_token;
}

/**
 * The logged-out shell at x.com/ is an SSR login wall with no app bundle.
 * /explore serves the real SPA, so the bundle is reachable while logged out.
 */
async function fetchBundle() {
  const html = await (
    await fetch('https://x.com/explore', { headers: { 'user-agent': UA } })
  ).text();

  const urls = [
    ...new Set(
      html.match(
        /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js/g,
      ) ?? [],
    ),
  ];
  const main = urls.find((u) => u.includes('/main.'));
  if (!main) throw new Error('main.<hash>.js not found in /explore');

  return {
    url: main,
    js: await (await fetch(main, { headers: { 'user-agent': UA } })).text(),
  };
}

/** Brace-match forward from `start` to return one balanced {...} literal. */
function matchObject(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * queryIds are emitted as webpack modules:
 *   e.exports={queryId:"…",operationName:"…",metadata:{featureSwitches:[…],fieldToggles:[…]}}
 * They rotate on every X frontend deploy, which is exactly why they are
 * extracted at runtime rather than hardcoded.
 */
function extractOperations(js) {
  const ops = new Map();
  const re = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
  for (const m of js.matchAll(re)) {
    const [, queryId, name] = m;
    const objStart = js.lastIndexOf('{', m.index);
    const obj = matchObject(js, objStart) ?? '';
    const fs = obj.match(/featureSwitches:\[(.*?)\]/s);
    const ft = obj.match(/fieldToggles:\[(.*?)\]/s);
    const list = (s) => [...(s?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    ops.set(name, {
      queryId,
      features: Object.fromEntries(list(fs).map((k) => [k, true])),
      fieldToggles: Object.fromEntries(list(ft).map((k) => [k, true])),
    });
  }
  return ops;
}

async function probe(name, meta, guestToken, variables = {}) {
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify({}),
    fieldToggles: JSON.stringify({}),
  });
  const res = await fetch(
    `https://x.com/i/api/graphql/${meta.queryId}/${name}?${qs}`,
    {
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-guest-token': guestToken,
        'user-agent': UA,
        accept: '*/*',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        referer: 'https://x.com/',
      },
    },
  );
  const body = await res.text();
  return {
    status: res.status,
    bytes: body.length,
    rateLimit: res.headers.get('x-rate-limit-limit'),
    verdict:
      res.status === 404
        ? 'GATED'
        : res.status === 422 || res.status === 200
          ? 'PERMITTED'
          : `HTTP ${res.status}`,
  };
}

const main = async () => {
  console.log(`probe run: ${new Date().toISOString()}\n`);

  const guestToken = await mintGuestToken();
  console.log(`guest token minted: ${guestToken.slice(0, 10)}…  (HTTP 200)`);

  const { url, js } = await fetchBundle();
  const ops = extractOperations(js);
  console.log(`bundle: ${url.split('/').pop()}  (${ops.size} operations)\n`);

  console.log(`${'operation'.padEnd(44)} ${'code'.padEnd(5)} verdict`);
  console.log('-'.repeat(72));

  const results = [];
  for (const name of TARGETS) {
    const meta = ops.get(name);
    if (!meta) {
      console.log(`${name.padEnd(44)} ${'--'.padEnd(5)} not in logged-out bundle`);
      continue;
    }
    const r = await probe(name, meta, guestToken);
    results.push({ name, ...r });
    console.log(`${name.padEnd(44)} ${String(r.status).padEnd(5)} ${r.verdict}`);
  }

  const permitted = results.filter((r) => r.verdict === 'PERMITTED');
  console.log(
    `\n${permitted.length} of ${results.length} operations permitted for guests: ` +
      permitted.map((r) => r.name).join(', '),
  );
  console.log(
    '\nInterpretation: the permitted set is exactly the surface a logged-out\n' +
      'browser can render — one profile, or one tweet. Search is not on it.',
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
