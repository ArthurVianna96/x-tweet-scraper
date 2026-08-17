/**
 * Refreshes the committed test fixtures from live X.
 *
 *   npx tsx src/tools/capture-fixtures.ts elonmusk apify naval paulg
 *
 * The test suite is offline and deterministic (SPEC.md §8), which costs us the ability
 * to notice X changing its response shape — a real limitation, documented in the README
 * rather than papered over. This tool is the mitigation: re-capturing is one command, so
 * a shape change is minutes of work rather than an archaeology project.
 *
 * It saves two kinds of fixture:
 *   - one full raw timeline payload, for the extractor test (entries, modules, cursors,
 *     pinned entry — the structure is the point);
 *   - curated single tweets, one per normalizer edge case, auto-selected by scanning
 *     everything captured. Each is stamped with where it came from.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGotClient } from '../adapters/http/got-client.js';
import { XClient } from '../adapters/x/graphql.js';
import { asArray, asString, path } from '../adapters/x/json.js';
import { fetchUserByScreenName } from '../adapters/x/operations.js';
import { QueryIdResolver } from '../adapters/x/query-ids.js';
import { SessionPool, generateBrowserHeaders } from '../adapters/x/session.js';
import { extractTimelinePage } from '../adapters/x/timeline.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');

/** One predicate per normalizer edge case in SPEC.md §3.2 / §8. */
const CASES: ReadonlyArray<{ name: string; matches: (tweet: unknown) => boolean }> = [
  {
    name: 'tweet-retweet',
    // `legacy.full_text` here is truncated to ~140 chars; the real text is one level down.
    matches: (t) => path(t, 'legacy', 'retweeted_status_result', 'result') !== undefined,
  },
  {
    name: 'tweet-long-form',
    // Long-form posts truncate in a *different* place — `note_tweet`, not the retweet path.
    matches: (t) => path(t, 'note_tweet', 'note_tweet_results', 'result', 'text') !== undefined,
  },
  {
    name: 'tweet-quote',
    matches: (t) =>
      path(t, 'quoted_status_result', 'result') !== undefined &&
      path(t, 'legacy', 'retweeted_status_result') === undefined,
  },
  {
    name: 'tweet-media',
    matches: (t) => asArray(path(t, 'legacy', 'extended_entities', 'media')).length > 0,
  },
  {
    name: 'tweet-reply',
    matches: (t) => asString(path(t, 'legacy', 'in_reply_to_status_id_str')) !== null,
  },
  {
    name: 'tweet-links',
    matches: (t) =>
      asArray(path(t, 'legacy', 'entities', 'urls')).length > 0 &&
      asArray(path(t, 'legacy', 'extended_entities', 'media')).length === 0,
  },
  {
    name: 'tweet-plain',
    // `mediaType: text_only` means no media *and* no links (SPEC.md §3.1), and a quote
    // is not plain either — this fixture is the one that must match nothing but text.
    matches: (t) =>
      asArray(path(t, 'legacy', 'entities', 'urls')).length === 0 &&
      asArray(path(t, 'legacy', 'extended_entities', 'media')).length === 0 &&
      path(t, 'legacy', 'retweeted_status_result') === undefined &&
      path(t, 'quoted_status_result') === undefined &&
      path(t, 'note_tweet') === undefined &&
      asString(path(t, 'legacy', 'in_reply_to_status_id_str')) === null,
  },
];

/**
 * A real timeline page is ~750 KB, most of it repeated author objects. The extractor
 * test cares about *structure* — item entries, conversation modules, both cursors, the
 * pinned entry, the terminate instruction — so we keep one of each kind and drop the
 * rest. Everything retained is verbatim; nothing is synthesised.
 */
function trimTimelinePage(raw: unknown, keepEntries = 6): unknown {
  const clone = structuredClone(raw) as Record<string, unknown>;
  const instructions = asArray(
    path(clone, 'data', 'user', 'result', 'timeline', 'timeline', 'instructions'),
  );

  for (const instruction of instructions) {
    const record = instruction as Record<string, unknown>;
    if (record['type'] !== 'TimelineAddEntries') continue;

    const entries = asArray(record['entries']);
    const cursors = entries.filter(
      (e) => asString(path(e, 'content', 'entryType')) === 'TimelineTimelineCursor',
    );
    const modules = entries
      .filter((e) => asString(path(e, 'content', 'entryType')) === 'TimelineTimelineModule')
      .slice(0, 2);
    const items = entries
      .filter((e) => asString(path(e, 'content', 'entryType')) === 'TimelineTimelineItem')
      .slice(0, keepEntries - modules.length);

    record['entries'] = [...items, ...modules, ...cursors];
    record['_trimmed'] =
      `kept ${items.length} items + ${modules.length} modules + ${cursors.length} cursors of ${entries.length} entries`;
  }

  return clone;
}

async function save(name: string, payload: unknown): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(
    resolve(FIXTURE_DIR, `${name}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`  saved ${name}.json\n`);
}

async function main(): Promise<void> {
  const handles = process.argv.slice(2);
  if (handles.length === 0) {
    process.stderr.write('usage: tsx src/tools/capture-fixtures.ts <handle> [handle…]\n');
    process.exitCode = 1;
    return;
  }

  const http = createGotClient();
  const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 1 });
  const queryIds = new QueryIdResolver(http, () => ({ headers: generateBrowserHeaders() }));
  const client = new XClient({ http, pool, queryIds });

  const found = new Map<string, { tweet: unknown; handle: string }>();
  let rawPageSaved = false;

  for (const handle of handles) {
    process.stdout.write(`@${handle}\n`);
    try {
      const user = await fetchUserByScreenName(client, handle);
      let cursor: string | null = null;

      for (let page = 0; page < 3; page++) {
        const raw = await client.call(
          'UserTweets',
          {
            userId: user.id,
            count: 20,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: true,
            ...(cursor === null ? {} : { cursor }),
          },
          { target: handle },
        );

        const extracted = extractTimelinePage(raw);
        process.stdout.write(`  page ${page}: ${extracted.results.length} tweets\n`);

        // One real payload, kept whole: the extractor test needs the structure, not a
        // hand-written approximation of it.
        if (!rawPageSaved && extracted.results.length > 0 && extracted.nextCursor !== null) {
          await save('timeline-page', trimTimelinePage(raw));
          rawPageSaved = true;
        }

        for (const tweet of extracted.results) {
          for (const testCase of CASES) {
            if (!found.has(testCase.name) && testCase.matches(tweet)) {
              found.set(testCase.name, { tweet, handle });
            }
          }
        }

        if (extracted.nextCursor === null || extracted.results.length === 0) break;
        cursor = extracted.nextCursor;
      }
    } catch (err) {
      const error = err as Error;
      process.stdout.write(`  ${error.name}: ${error.message}\n`);
      await save(`unavailable-${handle}`, { name: error.name, message: error.message });
    }
  }

  for (const [name, { tweet, handle }] of found) {
    await save(name, { _capturedFrom: `@${handle}`, _capturedAt: new Date().toISOString(), tweet });
  }

  const missing = CASES.filter((c) => !found.has(c.name)).map((c) => c.name);
  if (missing.length > 0) {
    process.stdout.write(`\nnot found in these accounts: ${missing.join(', ')}\n`);
  }
  process.stdout.write(
    `\nbundle: ${queryIds.resolvedBundleUrl ?? 'n/a'}\n` +
      `requests: ${client.stats.requests}  errors: ${JSON.stringify(client.stats.errors)}\n`,
  );
}

await main();
