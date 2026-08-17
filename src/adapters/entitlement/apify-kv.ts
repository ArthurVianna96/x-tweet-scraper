import { createHmac } from 'node:crypto';

import type { ApifyClient } from 'apify-client';

/**
 * How the entitlement record is obtained; the decision itself is in `domain/entitlement`.
 *
 * Two design points, argued in full in the README. Identity comes from the credential
 * rather than a claim, because asking the platform who a token belongs to is
 * self-validating. And the store is public-read on purpose: inside a run `APIFY_TOKEN`
 * belongs to the runner, so a private store would be unreachable from the runs that need
 * it. Write access is the authority, and HMAC'd keys mean a world-readable store names
 * nobody.
 */

export interface EntitlementSourceOptions {
  /** Authenticated as the runner, which is the only client a run has. */
  readonly client: ApifyClient;
  readonly storeId: string;
  /** Must be a Secret env var: a published Actor shows non-secret ones on its page. */
  readonly hmacKey: string;
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

    // A missing record is an answer, not a failure: an unprovisioned user is free.
    return record?.value ?? null;
  };
}

/**
 * Asked of the platform, never read from a claim.
 *
 * Two routes because Apify runs deployed Actors under a scoped token that `/users/me`
 * refuses. The fallback still asks the API rather than trusting the environment: the run
 * id only names a resource, and a run-scoped token may read its own run and nothing else,
 * so a forged id is refused and the verdict falls back to free.
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
 * Shared with the provisioning tool so the two cannot drift. A mismatch caps a paying
 * customer with no error anywhere.
 */
export function entitlementKeyFor(userId: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(userId).digest('hex');
}

/** `null` when the Actor was deployed without entitlement config: unverifiable, not free. */
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
