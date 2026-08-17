/**
 * The single chokepoint through which every result reaches the dataset (SPEC.md §4.3).
 *
 * The free-tier cap is enforced *here*, at push time, and nowhere else. It is
 * deliberately not enforced by clamping `maxResults` on the way in: brief §6 rejects
 * client-side limits as protection, and a clamp is trivially defeated by editing the
 * input schema in a fork. Clamping still happens as an optimisation upstream — but this
 * class is the invariant.
 *
 * Because `push()` reports "stop now", the cap also stops *fetching*: the caller breaks
 * out of the `for await` loop, which unwinds the lazy crawl generator, which stops
 * paging cursors. A free user asking for 1000 results costs us roughly one page.
 */
export interface ResultSinkOptions<T> {
  /** Hard ceiling on total items pushed for the lifetime of this run. */
  readonly cap: number;
  /** The effect. Injected so unit tests need no platform and no network (SPEC.md §8). */
  readonly push: (item: T) => Promise<void>;
  /**
   * Items already in the dataset from a previous incarnation of this run.
   *
   * Must be floored on an authority the runner cannot lower — `dataset.itemCount`,
   * not a persisted counter in their own key-value store (SPEC.md §4.5).
   */
  readonly alreadyPushed?: number;
}

/**
 * How many items this run must be considered to have already pushed, when resuming
 * after a migration or a resurrect (SPEC.md §4.5).
 *
 * The run's key-value store belongs to the *runner*, so a persisted counter is
 * attacker-writable: set it to 0, resurrect the run, collect another 10, repeat. Even
 * without tampering, a naive resume that restarts at 0 hands out 10 more per resurrect.
 *
 * `dataset.itemCount` is the floor because it is the one number they cannot lower
 * without deleting the very results they were trying to accumulate.
 */
export function resumePushCount(
  persisted: number | null | undefined,
  datasetItemCount: number,
): number {
  return Math.max(persisted ?? 0, datasetItemCount);
}

export class ResultSink<T> {
  private pushed: number;

  constructor(private readonly opts: ResultSinkOptions<T>) {
    this.pushed = opts.alreadyPushed ?? 0;
  }

  /** Items pushed so far, including any carried over from a resumed run. */
  get count(): number {
    return this.pushed;
  }

  get capacityReached(): boolean {
    return this.pushed >= this.opts.cap;
  }

  /**
   * @returns `false` when the caller must stop — either the item was refused because
   * the cap was already reached, or it was accepted and the cap is now full. Both mean
   * the same thing to a caller, which is why one boolean is enough.
   */
  async push(item: T): Promise<boolean> {
    if (this.pushed >= this.opts.cap) return false;

    // Increment BEFORE awaiting the effect. With N parallel account chains feeding one
    // sink, any `await` between the check and the increment lets every worker pass the
    // check on the same value and overshoot the cap. That bug is intermittent and
    // passes every test in SPEC.md §8, so the ordering is load-bearing, not stylistic.
    //
    // The cost of this ordering: a `push` that throws still consumed its slot. That errs
    // toward delivering fewer items than the cap, which is the safe direction for a gate.
    this.pushed++;
    await this.opts.push(item);

    return this.pushed < this.opts.cap;
  }
}
