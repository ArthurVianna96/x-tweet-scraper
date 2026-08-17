import { z } from 'zod';

/**
 * Entitlement policy (SPEC.md §4.4, §4.6). Pure: the *decision*, not the lookup.
 *
 * Identity resolution (§4.1) and the HMAC'd store read (§4.2) are adapter concerns —
 * see `adapters/entitlement/`. This module only answers: given whatever came back,
 * is this run paid? It defaults to deny, always.
 */

/** Brief §6: unverified users are capped at 10 results per run. */
export const FREE_TIER_CAP = 10;

export type LimitReason =
  /** We verified the user and they are on the free tier. Expected, not alertable. */
  | 'free_tier'
  /**
   * We could not verify. Same cap, different meaning: a *paying* customer may be
   * getting capped right now. This is the condition worth an alert (SPEC.md §4.6).
   */
  | 'entitlement_unavailable';

export interface Entitlement {
  readonly paid: boolean;
  readonly limited: boolean;
  readonly reason: LimitReason | null;
  /** `null` means uncapped — the user's own `maxResults` is the only limit. */
  readonly cap: number | null;
  /** Human-readable cause, for the structured log line. `null` when nothing went wrong. */
  readonly detail: string | null;
}

/**
 * Extra keys are tolerated (`plan`, `updatedAt`, …) so the store can grow without a
 * deploy, but `paid` must be a real boolean. `undefined` must never reach the check.
 */
const EntitlementRecord = z.object({ paid: z.boolean() }).passthrough();

const PAID: Entitlement = {
  paid: true,
  limited: false,
  reason: null,
  cap: null,
  detail: null,
};

const free = (reason: LimitReason, detail: string | null = null): Entitlement => ({
  paid: false,
  limited: true,
  reason,
  cap: FREE_TIER_CAP,
  detail,
});

/**
 * Resolve the verdict for this run.
 *
 * @param fetchRecord Reads the entitlement record for the runner. Resolves to `null`
 *   when no record exists (an unknown user is simply a free user), and **throws** when
 *   the lookup itself failed — network, timeout, auth. The two are different verdicts,
 *   which is why they are different signals. Timeouts belong to the adapter (an
 *   `AbortSignal`), so this stays pure and instantly testable.
 *
 * Fails closed on every path: there is no input to this function that yields `paid`
 * except a well-formed record that literally says `paid: true`.
 */
export async function resolveEntitlement(
  fetchRecord: () => Promise<unknown>,
): Promise<Entitlement> {
  let record: unknown;
  try {
    record = await fetchRecord();
  } catch (err) {
    return free('entitlement_unavailable', errorMessage(err));
  }

  // No record at all is a definite answer: this user has never been provisioned.
  if (record === null || record === undefined) return free('free_tier');

  const parsed = EntitlementRecord.safeParse(record);
  if (!parsed.success) {
    // Our own store is malformed. Cap, but flag it as unverified rather than as a
    // confirmed free user — the distinction is the whole point of §4.6.
    return free('entitlement_unavailable', 'malformed entitlement record');
  }

  // `=== true`, never `!== false`. With `!== false`, an absent field would read as
  // paid and hand out unlimited results (SPEC.md §4.4).
  return parsed.data.paid === true ? PAID : free('free_tier');
}

/**
 * The cap actually applied to this run: the user's request, lowered to the free ceiling
 * when they are not entitled. Asking for 1000 on the free tier yields 10.
 */
export function effectiveCap(entitlement: Entitlement, maxResults: number): number {
  if (entitlement.cap === null) return maxResults;
  return Math.min(maxResults, entitlement.cap);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
