import { Actor, log } from 'apify';
import { z } from 'zod';

import type { Tweet } from '../domain/types.js';

/**
 * Checkpointed run state, for migrations and resurrects.
 *
 * This store belongs to the runner, so everything here is attacker-writable. Fine for
 * cursors and the seen-set, where tampering only costs the user a re-scrape. Not fine for
 * `pushed`, which is why `resumePushCount` floors it on the dataset's own count — treat
 * the value below as a hint, never an authority.
 */
export const STATE_KEY = 'CRAWL_STATE';

/** Bounded so a long run cannot grow the checkpoint without limit. */
const MAX_SEEN_KEYS = 50_000;

/** Above this the buffer is dropped rather than risking the whole record. */
const MAX_BUFFERED_RESULTS = 5_000;

export interface RunState {
  readonly pushed: number;
  readonly cursors: Record<string, string>;
  readonly seen: readonly string[];
  readonly buffer: readonly Tweet[];
}

const RunStateSchema = z.object({
  pushed: z.number().int().nonnegative().catch(0),
  cursors: z.record(z.string()).catch({}),
  seen: z.array(z.string()).catch([]),
  // Loose: these came from our own normalizer, and a bad entry costs one row.
  buffer: z.array(z.unknown()).catch([]),
});

const EMPTY: RunState = { pushed: 0, cursors: {}, seen: [], buffer: [] };

export async function loadState(): Promise<RunState> {
  try {
    const raw = await Actor.getValue(STATE_KEY);
    if (raw === null || raw === undefined) return EMPTY;

    const parsed = RunStateSchema.safeParse(raw);
    if (!parsed.success) return EMPTY;

    return {
      pushed: parsed.data.pushed,
      cursors: parsed.data.cursors,
      seen: parsed.data.seen,
      buffer: parsed.data.buffer as Tweet[],
    };
  } catch (err) {
    // An unreadable checkpoint is a reason to start clean, not to fail the run.
    log.warning('could not read checkpoint, starting fresh', { message: (err as Error).message });
    return EMPTY;
  }
}

export async function persistState(state: RunState): Promise<void> {
  try {
    // The buffer is the only unbounded part of this state. Dropping it costs a re-fetch;
    // exceeding the record size limit would lose the cursors too.
    const buffer = state.buffer.length > MAX_BUFFERED_RESULTS ? [] : state.buffer;
    if (buffer.length !== state.buffer.length) {
      log.warning('checkpoint dropped the result buffer — too large to persist', {
        items: state.buffer.length,
      });
    }

    await Actor.setValue(STATE_KEY, {
      ...state,
      buffer,
      seen: state.seen.slice(-MAX_SEEN_KEYS),
    });
  } catch (err) {
    log.warning('checkpoint failed', { message: (err as Error).message });
  }
}
