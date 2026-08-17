import { Actor, log } from 'apify';
import { z } from 'zod';

import type { Tweet } from '../domain/types.js';

/**
 * Checkpointed run state (SPEC.md §5.3), for `migrating` and for resurrects.
 *
 * **This store belongs to the runner, not to us.** Inside a run, `APIFY_TOKEN` is the
 * *runner's* token, so everything written here is attacker-writable. That is fine for
 * cursors and the seen-set — the worst outcome of tampering is that the user re-scrapes
 * and pays for it — and specifically **not** fine for the pushed counter, which is why
 * `resumePushCount` floors whatever is read here on `dataset.itemCount` (§4.5).
 *
 * The `pushed` value below is therefore a hint, never an authority.
 */
export const STATE_KEY = 'CRAWL_STATE';

/** Bounded so a long run cannot grow the checkpoint without limit. */
const MAX_SEEN_KEYS = 50_000;

/** Above this, the buffer is dropped from the checkpoint rather than risking the record. */
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
  // Buffered results are re-validated loosely: they were produced by our own normalizer,
  // and a malformed entry costs one bad row, not a bypass.
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
    // A checkpoint we cannot read is not a reason to fail the run — it is a reason to
    // start clean. The cap is protected by `dataset.itemCount` regardless.
    log.warning('could not read checkpoint, starting fresh', { message: (err as Error).message });
    return EMPTY;
  }
}

export async function persistState(state: RunState): Promise<void> {
  try {
    /**
     * A key-value record has a size limit, and the buffer is the only unbounded part of
     * this state. Dropping it costs a re-fetch after a migration; exceeding the limit
     * would fail the checkpoint entirely and lose the cursors too.
     */
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
