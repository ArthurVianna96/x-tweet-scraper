/**
 * The one place the free-tier cap is enforced. Clamping `maxResults` on the way in is an
 * optimisation, not the protection: a client-side limit is defeated by editing the input.
 */
export interface ResultSinkOptions<T> {
  readonly cap: number;
  readonly push: (item: T) => Promise<void>;
  readonly alreadyPushed?: number;
}

/**
 * The run's key-value store belongs to the runner, so a persisted counter is
 * attacker-writable: set it to 0, resurrect the run, collect another 10, repeat.
 * `dataset.itemCount` is the floor because lowering it means deleting the results they
 * were trying to accumulate.
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

  get count(): number {
    return this.pushed;
  }

  get capacityReached(): boolean {
    return this.pushed >= this.opts.cap;
  }

  /** @returns `false` when the caller must stop: the cap is now full, or already was. */
  async push(item: T): Promise<boolean> {
    if (this.pushed >= this.opts.cap) return false;

    // Increment before awaiting. With concurrent producers, an await between the check
    // and the increment lets every one of them pass the check on the same value.
    this.pushed++;
    await this.opts.push(item);

    return this.pushed < this.opts.cap;
  }
}
