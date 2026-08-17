import { asArray, asRecord, asString, path, typenameOf } from './json.js';

/**
 * Timeline extraction, by path and never by type.
 *
 * ```
 * data.user.result.timeline.timeline.instructions[]
 *   └─ type "TimelineAddEntries"
 *        └─ entries[]
 *             ├─ "TimelineTimelineItem"   → content.itemContent.tweet_results.result
 *             ├─ "TimelineTimelineModule" → content.items[].item.itemContent.tweet_results.result
 *             └─ "TimelineTimelineCursor" → cursorType "Bottom" → next page
 * ```
 *
 * Walking the payload for every `__typename === "Tweet"` looks equivalent and is not: a
 * tweet's `retweeted_status_result` and `quoted_status_result` are structurally identical
 * to a top-level tweet, so recursion emits the same content two and three times.
 */

export interface TimelinePage {
  /** Raw `tweet_results.result` objects, one per timeline entry. Never nested originals. */
  readonly results: readonly unknown[];
  /** Cursor for the next page, or `null` when the timeline is exhausted. */
  readonly nextCursor: string | null;
  /** Reported, not obeyed — see `isBottomTerminated`. Useful in logs. */
  readonly terminated: boolean;
}

/**
 * "Terminated means stop paging" is the obvious reading and it is wrong: X emits this on
 * every page of a paginated timeline while the bottom cursor keeps returning fresh
 * tweets. Obeying it costs most of the recall, silently — nothing errors.
 *
 * So it is reported, not obeyed, and the real stop conditions are structural.
 */
export function isBottomTerminated(direction: string | null): boolean {
  if (direction === null) return true; // no direction stated: the conservative reading
  return direction === 'Bottom' || direction === 'TopAndBottom';
}

export function extractTimelinePage(payload: unknown): TimelinePage {
  const instructions = asArray(findInstructions(payload));
  const results: unknown[] = [];
  let nextCursor: string | null = null;
  let terminated = false;

  for (const instruction of instructions) {
    const type = asString(path(instruction, 'type'));

    if (type === 'TimelineTerminateTimeline') {
      if (isBottomTerminated(asString(path(instruction, 'direction')))) terminated = true;
      continue;
    }

    // Cursors also arrive as standalone instructions on some responses.
    if (type === 'TimelineReplaceEntry') {
      const cursor = readCursor(path(instruction, 'entry'));
      if (cursor !== null) nextCursor = cursor;
      continue;
    }

    // Skips `TimelinePinEntry` deliberately: a pinned tweet is an arbitrarily old tweet
    // served at the top, and emitting it would corrupt `sortBy: latest`.
    if (type !== 'TimelineAddEntries') continue;

    for (const entry of asArray(path(instruction, 'entries'))) {
      const content = path(entry, 'content');
      const entryType = asString(path(content, 'entryType'));

      if (entryType === 'TimelineTimelineItem') {
        const result = path(content, 'itemContent', 'tweet_results', 'result');
        if (result !== undefined) results.push(unwrapVisibility(result));
        continue;
      }

      if (entryType === 'TimelineTimelineModule') {
        // Conversation modules hold several tweets under one entry.
        for (const item of asArray(path(content, 'items'))) {
          const result = path(item, 'item', 'itemContent', 'tweet_results', 'result');
          if (result !== undefined) results.push(unwrapVisibility(result));
        }
        continue;
      }

      if (entryType === 'TimelineTimelineCursor') {
        const cursor = readCursor(entry);
        if (cursor !== null) nextCursor = cursor;
      }
    }
  }

  return { results, nextCursor, terminated };
}

/** X has served this under both `timeline` and `timeline_v2`; probing both costs nothing. */
function findInstructions(payload: unknown): unknown {
  const user = path(payload, 'data', 'user', 'result');
  return (
    path(user, 'timeline', 'timeline', 'instructions') ??
    path(user, 'timeline_v2', 'timeline', 'instructions') ??
    path(user, 'timeline', 'instructions') ??
    []
  );
}

/** This wrapper holds the real tweet one level down, beside a visibility notice. */
export function unwrapVisibility(result: unknown): unknown {
  if (typenameOf(result) === 'TweetWithVisibilityResults') {
    return path(result, 'tweet') ?? result;
  }
  return result;
}

function readCursor(entry: unknown): string | null {
  const content = asRecord(path(entry, 'content')) ?? asRecord(path(entry, 'item', 'itemContent'));
  if (content === null) return null;

  const isCursor =
    asString(content['entryType']) === 'TimelineTimelineCursor' ||
    asString(content['itemType']) === 'TimelineTimelineCursor';
  if (!isCursor) return null;

  // "Bottom" pages forward; "Top" walks back into newer tweets.
  if (asString(content['cursorType']) !== 'Bottom') return null;
  return asString(content['value']);
}

/** The reason an account yielded no timeline, when X says so explicitly. */
export function readUnavailableReason(
  payload: unknown,
): 'protected' | 'suspended' | 'not_found' | null {
  const result = path(payload, 'data', 'user', 'result');

  if (typenameOf(result) === 'UserUnavailable') {
    const reason = asString(path(result, 'reason'))?.toLowerCase() ?? '';
    if (reason.includes('suspend')) return 'suspended';
    if (reason.includes('protect')) return 'protected';
    return 'not_found';
  }

  if (result === undefined) {
    const errors = asArray(path(payload, 'errors'));
    for (const error of errors) {
      const message = asString(path(error, 'message'))?.toLowerCase() ?? '';
      if (message.includes('suspend')) return 'suspended';
      if (message.includes('not found') || message.includes('could not be found')) {
        return 'not_found';
      }
    }
    if (errors.length > 0) return 'not_found';
  }

  // A protected account returns a valid user with an empty timeline.
  if (path(result, 'legacy', 'protected') === true) return 'protected';

  return null;
}
