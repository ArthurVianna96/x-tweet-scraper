import { describe, expect, it, vi } from 'vitest';

import type { XClient } from './graphql.js';
import { streamUserTweets } from './operations.js';

/**
 * Pagination stop conditions (SPEC.md §2, and the terminate-direction finding in
 * `timeline.ts`). The client is a stub returning canned pages, so this is pure logic.
 */

interface FakePage {
  ids: string[];
  cursor: string | null;
  /** X sends this on every page of a paginated timeline; obeying it truncates the crawl. */
  terminate?: 'Top' | 'Bottom' | 'TopAndBottom';
}

function stubClient(pages: FakePage[]): { client: XClient; calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;

  const client = {
    async call(_operation: string, variables: Record<string, unknown>) {
      calls.push(variables);
      const page = pages[index++] ?? { ids: [], cursor: null };

      const entries = page.ids.map((id) => ({
        entryId: `tweet-${id}`,
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: { tweet_results: { result: { rest_id: id, legacy: {} } } },
        },
      }));

      if (page.cursor !== null) {
        entries.push({
          entryId: 'cursor-bottom',
          content: {
            entryType: 'TimelineTimelineCursor',
            cursorType: 'Bottom',
            value: page.cursor,
          },
        } as unknown as (typeof entries)[number]);
      }

      const instructions: unknown[] = [{ type: 'TimelineAddEntries', entries }];
      if (page.terminate !== undefined) {
        instructions.push({ type: 'TimelineTerminateTimeline', direction: page.terminate });
      }

      return { data: { user: { result: { timeline: { timeline: { instructions } } } } } };
    },
  } as unknown as XClient;

  return { client, calls };
}

const drain = async (stream: AsyncGenerator<unknown>): Promise<string[]> => {
  const ids: string[] = [];
  for await (const tweet of stream) ids.push((tweet as { rest_id: string }).rest_id);
  return ids;
};

describe('streamUserTweets', () => {
  it('follows the bottom cursor across pages', async () => {
    const { client } = stubClient([
      { ids: ['3', '2'], cursor: 'c1' },
      { ids: ['1'], cursor: null },
    ]);

    expect(await drain(streamUserTweets(client, { userId: '1', handle: 'tester' }))).toEqual([
      '3',
      '2',
      '1',
    ]);
  });

  it('keeps paging through TimelineTerminateTimeline, which X sends on every page', async () => {
    // Measured on @apify: `TopAndBottom` arrives on page 0 alongside a cursor that keeps
    // returning fresh tweets. Obeying it truncated that account from 92 tweets to 19.
    const { client } = stubClient([
      { ids: ['3'], cursor: 'c1', terminate: 'TopAndBottom' },
      { ids: ['2'], cursor: 'c2', terminate: 'TopAndBottom' },
      { ids: ['1'], cursor: null, terminate: 'TopAndBottom' },
    ]);

    expect(await drain(streamUserTweets(client, { userId: '1', handle: 'tester' }))).toEqual([
      '3',
      '2',
      '1',
    ]);
  });

  it('stops when the cursor stops advancing', async () => {
    const { client, calls } = stubClient([
      { ids: ['2'], cursor: 'same' },
      { ids: ['1'], cursor: 'same' },
    ]);

    await drain(streamUserTweets(client, { userId: '1', handle: 'tester' }));
    expect(calls).toHaveLength(2);
  });

  it('stops when a page repeats what it already served, rather than cycling forever', async () => {
    const { client, calls } = stubClient([
      { ids: ['2', '1'], cursor: 'c1' },
      { ids: ['2', '1'], cursor: 'c2' },
      { ids: ['0'], cursor: null },
    ]);

    const ids = await drain(streamUserTweets(client, { userId: '1', handle: 'tester' }));

    expect(ids).toEqual(['2', '1']);
    expect(calls).toHaveLength(2);
  });

  it('stops on an empty page', async () => {
    const { client, calls } = stubClient([{ ids: [], cursor: 'c1' }]);

    expect(await drain(streamUserTweets(client, { userId: '1', handle: 'tester' }))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('honours maxPages', async () => {
    const { client, calls } = stubClient([
      { ids: ['3'], cursor: 'c1' },
      { ids: ['2'], cursor: 'c2' },
      { ids: ['1'], cursor: 'c3' },
    ]);

    await drain(streamUserTweets(client, { userId: '1', handle: 'tester', maxPages: 2 }));
    expect(calls).toHaveLength(2);
  });

  it('resumes from a persisted cursor', async () => {
    const { client, calls } = stubClient([{ ids: ['1'], cursor: null }]);

    await drain(
      streamUserTweets(client, { userId: '1', handle: 'tester', startCursor: 'saved-cursor' }),
    );

    expect((calls[0] as { cursor?: string }).cursor).toBe('saved-cursor');
  });

  it('reports a page as fetched before its tweets are consumed', async () => {
    // A page that was fetched has been paid for even if the consumer stops halfway —
    // which is what every free-tier run does.
    const onPage = vi.fn();
    const { client } = stubClient([{ ids: ['3', '2', '1'], cursor: 'c1' }]);

    const stream = streamUserTweets(client, { userId: '1', handle: 'tester' }, onPage);
    await stream.next();

    expect(onPage).toHaveBeenCalledWith({ cursor: 'c1', count: 3, fresh: 3, terminated: false });
  });

  it('is lazy — constructing the stream fetches nothing', () => {
    const { client, calls } = stubClient([{ ids: ['1'], cursor: null }]);

    streamUserTweets(client, { userId: '1', handle: 'tester' });
    expect(calls).toHaveLength(0);
  });
});
