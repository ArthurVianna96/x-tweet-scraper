import { z } from 'zod';

/**
 * The entitlement decision, not the lookup. Given whatever came back from the store, is
 * this run paid? Defaults to deny on every path.
 */

export const FREE_TIER_CAP = 10;

export type LimitReason =
  | 'free_tier'
  /** Could not verify. Same cap, but this one may be capping a paying customer. */
  | 'entitlement_unavailable';

export interface Entitlement {
  readonly paid: boolean;
  readonly limited: boolean;
  readonly reason: LimitReason | null;
  /** `null` means uncapped — the caller's own `maxResults` is the only limit. */
  readonly cap: number | null;
  readonly detail: string | null;
}

/** Extra keys are tolerated so the store can grow without a deploy. `paid` may not be. */
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
 * @param fetchRecord Resolves to `null` when the user has no record — an unprovisioned
 *   user is a free user — and throws when the lookup itself failed. Those are different
 *   verdicts, so they are different signals.
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

  if (record === null || record === undefined) return free('free_tier');

  const parsed = EntitlementRecord.safeParse(record);
  if (!parsed.success) {
    // Our own store is malformed: cap, but as unverified rather than confirmed free.
    return free('entitlement_unavailable', 'malformed entitlement record');
  }

  // `=== true`, never `!== false`, which would read an absent field as paid.
  return parsed.data.paid === true ? PAID : free('free_tier');
}

export function effectiveCap(entitlement: Entitlement, maxResults: number): number {
  if (entitlement.cap === null) return maxResults;
  return Math.min(maxResults, entitlement.cap);
}

/**
 * The push cap does not bound cost on its own: it stops the run at 10 *matches*, and a
 * selective filter may exhaust the account frontier without ever reaching 10. So an
 * unverified run is bounded on both axes — results by the cap, requests by this
 * allowance.
 */
export const FREE_TIER_REQUESTS_PER_RESULT = 10;

export function requestBudgetFor(entitlement: Entitlement, configuredBudget: number): number {
  if (entitlement.cap === null) return configuredBudget;
  return Math.min(configuredBudget, entitlement.cap * FREE_TIER_REQUESTS_PER_RESULT);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
