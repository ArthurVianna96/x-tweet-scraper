import { createHmac } from 'node:crypto';

import type { ApifyClient } from 'apify-client';

/**
 * Entitlement lookup (SPEC.md §4.1, §4.2). The *decision* lives in
 * `domain/entitlement.ts`; this is only how we obtain the record.
 *
 * Two non-obvious things are load-bearing here.
 *
 * **Identity comes from the credential, not the claim.** `APIFY_USER_ID` is, per Apify's
 * own docs, "ID of the user who started the Actor" — an environment variable, which
 * brief §6 explicitly names as untrusted. `APIFY_TOKEN` is strictly stronger: it is a
 * credential the *authority* validates. Asking the platform "who does this token belong
 * to?" is self-validating — a forged token is either rejected (→ fail closed → free) or
 * genuinely someone else's (→ correctly returns their entitlement).
 *
 * **The store is public, and that is the design, not a compromise.** Inside a run,
 * `APIFY_TOKEN` belongs to the *runner*, so `Actor.getValue()` and the default key-value
 * store are authenticated as them — a private store on our account is unreachable from
 * inside the run. So the store is public-read and the authority is *write* access, which
 * stays ours. Public reads cannot change a verdict. Keys are HMAC'd so a world-readable
 * store leaks no customer IDs, and if the HMAC key ever leaked the attacker could
 * compute a key in a store that was already public — a smaller blast radius than the
 * alternative, where a leaked API token would let them grant themselves paid.
 */

export interface EntitlementSourceOptions {
  /** Authenticated as the runner — which is the only client a run actually has. */
  readonly client: ApifyClient;
  /** `username/store-name` or store id of the public entitlements store. */
  readonly storeId: string;
  /**
   * Must be a **Secret** env var in the Apify Console. A published Actor's non-secret
   * environment variables are publicly visible on its detail page, so a plain env var
   * would publish the authority itself (SPEC.md §4.2).
   */
  readonly hmacKey: string;
  /** `Actor.getEnv().actorRunId` — names the run whose owner the API will tell us. */
  readonly actorRunId?: string | undefined;
  readonly timeoutMs?: number;
}

export function createEntitlementLookup(opts: EntitlementSourceOptions): () => Promise<unknown> {
  return async () => {
    const timeoutMs = opts.timeoutMs ?? 10_000;

    const runnerUserId = await resolveRunnerUserId(opts, timeoutMs);

    const key = entitlementKeyFor(runnerUserId, opts.hmacKey);

    const record = await withTimeout(
      opts.client.keyValueStore(opts.storeId).getRecord(key),
      timeoutMs,
      'entitlement lookup',
    );

    // A missing record is a definite answer — an unprovisioned user is a free user — so
    // it resolves to null rather than throwing. Only a *failed* lookup throws.
    return record?.value ?? null;
  };
}

/**
 * Who is running this Actor — **asked of the platform, never read from a claim**.
 *
 * Two routes, because Apify runs Actors under scoped, limited-permission tokens: that
 * token is refused by `/users/me` with "Insufficient permissions", which took the primary
 * route out on the first deployed run while working perfectly in every local test.
 *
 * The fallback keeps the §4.1 principle intact. `APIFY_ACTOR_RUN_ID` is an environment
 * variable and therefore an untrusted *claim* — but it is only used to name a resource,
 * and the answer comes from the API, which returns the run's real owner. Pointing it at
 * somebody else's run does not impersonate them: a run-scoped token may read its own run
 * and nothing else, so a forged id is refused and the verdict fails closed to free.
 *
 * What we still refuse to do is read `APIFY_USER_ID` directly. That is a claim with no
 * authority behind it at all, and brief §6 names environment variables as untrusted.
 */
async function resolveRunnerUserId(
  opts: EntitlementSourceOptions,
  timeoutMs: number,
): Promise<string> {
  try {
    const user = await withTimeout(opts.client.user('me').get(), timeoutMs, 'identity lookup');
    if (typeof user?.id === 'string' && user.id.length > 0) return user.id;
  } catch (err) {
    if (opts.actorRunId === undefined) throw err;
  }

  if (opts.actorRunId === undefined) {
    throw new Error('could not resolve the runner identity from APIFY_TOKEN');
  }

  const run = await withTimeout(
    opts.client.run(opts.actorRunId).get(),
    timeoutMs,
    'run owner lookup',
  );
  const ownerId = run?.userId;
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error(`run ${opts.actorRunId} did not report an owner`);
  }
  return ownerId;
}

/**
 * The key a user's entitlement record lives under.
 *
 * Exported because provisioning a paid customer needs the *same* derivation the gate
 * uses — `src/tools/entitlement-key.ts` calls this rather than reimplementing it. Two
 * copies of an HMAC would drift silently, and the failure mode is a paying customer
 * capped at 10 with no error anywhere.
 */
export function entitlementKeyFor(userId: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(userId).digest('hex');
}

/**
 * Reads the configuration this lookup needs. Returns `null` when the Actor was deployed
 * without entitlement configuration, which the caller must treat as unverifiable —
 * capped, and flagged as `entitlement_unavailable` rather than silently free.
 */
export function readEntitlementConfig(
  env: NodeJS.ProcessEnv,
): { storeId: string; hmacKey: string } | null {
  const storeId = env['ENTITLEMENTS_STORE_ID'];
  const hmacKey = env['ENTITLEMENTS_HMAC_KEY'];

  if (typeof storeId !== 'string' || storeId.length === 0) return null;
  if (typeof hmacKey !== 'string' || hmacKey.length === 0) return null;

  return { storeId, hmacKey };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
