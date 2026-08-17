import { describe, expect, it } from 'vitest';

import { loadFixture } from '../../../test/support/fixtures.js';
import { extractTimelinePage, isBottomTerminated, readUnavailableReason } from './timeline.js';

const page = loadFixture('timeline-page');

describe('extractTimelinePage', () => {
  it('reads tweets from item entries and conversation modules', () => {
    const extracted = extractTimelinePage(page);

    expect(extracted.results.length).toBeGreaterThan(0);
    for (const result of extracted.results) {
      expect(result).toHaveProperty('rest_id');
    }
  });

  it('emits each tweet exactly once', () => {
    // The duplicate bug: a recursive `__typename === "Tweet"` walk
    // turned a 20-entry page into 32 items, because a tweet's retweeted/quoted originals
    // are structurally identical to a top-level tweet.
    const ids = extractTimelinePage(page).results.map(
      (result) => (result as { rest_id: string }).rest_id,
    );

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not emit nested retweeted or quoted originals as separate items', () => {
    const extracted = extractTimelinePage(page);
    const emitted = new Set(extracted.results.map((r) => (r as { rest_id: string }).rest_id));

    const nested = extracted.results.flatMap((result) => {
      const legacy = (result as { legacy?: Record<string, unknown> }).legacy ?? {};
      const quoted = (result as Record<string, unknown>)['quoted_status_result'];
      return [
        (legacy['retweeted_status_result'] as { result?: { rest_id?: string } })?.result?.rest_id,
        (quoted as { result?: { rest_id?: string } })?.result?.rest_id,
      ].filter((id): id is string => typeof id === 'string');
    });

    // Nested originals are context. If any of them appears as its own row, the extractor
    // has started recursing.
    for (const id of nested) {
      expect(emitted.has(id)).toBe(false);
    }
  });

  it('returns the Bottom cursor for the next page', () => {
    const extracted = extractTimelinePage(page);

    expect(extracted.nextCursor).toBeTypeOf('string');
    expect(extracted.nextCursor?.length ?? 0).toBeGreaterThan(0);
  });

  it('skips the pinned entry, which would corrupt sortBy: latest', () => {
    const pinned = (
      page as {
        data: {
          user: {
            result: {
              timeline: { timeline: { instructions: { type: string; entry?: unknown }[] } };
            };
          };
        };
      }
    ).data.user.result.timeline.timeline.instructions.find(
      (instruction) => instruction.type === 'TimelinePinEntry',
    );

    // The fixture must actually contain a pinned entry, or this test proves nothing.
    expect(pinned).toBeDefined();

    const pinnedId = (
      pinned as {
        entry: {
          content: { itemContent: { tweet_results: { result: { rest_id: string } } } };
        };
      }
    ).entry.content.itemContent.tweet_results.result.rest_id;
    const emitted = extractTimelinePage(page).results.map(
      (r) => (r as { rest_id: string }).rest_id,
    );

    expect(emitted).not.toContain(pinnedId);
  });

  it('survives a payload with no timeline at all', () => {
    expect(extractTimelinePage({})).toEqual({ results: [], nextCursor: null, terminated: false });
    expect(extractTimelinePage(null)).toEqual({ results: [], nextCursor: null, terminated: false });
  });
});

describe('isBottomTerminated', () => {
  it('treats Top-only termination as "nothing newer", not "nothing left"', () => {
    expect(isBottomTerminated('Top')).toBe(false);
    expect(isBottomTerminated('Bottom')).toBe(true);
    expect(isBottomTerminated('TopAndBottom')).toBe(true);
    expect(isBottomTerminated(null)).toBe(true);
  });
});

describe('readUnavailableReason', () => {
  it('recognises a suspended account', () => {
    const payload = {
      data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } },
    };
    expect(readUnavailableReason(payload)).toBe('suspended');
  });

  it('recognises a protected account', () => {
    const payload = { data: { user: { result: { legacy: { protected: true } } } } };
    expect(readUnavailableReason(payload)).toBe('protected');
  });

  it('recognises a missing account from the errors array', () => {
    const payload = { errors: [{ message: 'User not found.' }] };
    expect(readUnavailableReason(payload)).toBe('not_found');
  });

  it('returns null for a healthy payload', () => {
    expect(readUnavailableReason(page)).toBeNull();
  });
});
