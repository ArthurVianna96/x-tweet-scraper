import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from 'apify-client';

import { createEntitlementLookup, entitlementKeyFor, readEntitlementConfig } from './apify-kv.js';

/**
 * Identity resolution under Apify's run-scoped tokens.
 *
 * The first deployed run failed here: Actors run under `LIMITED_PERMISSIONS`, and that
 * token is refused by `/users/me` with "Insufficient permissions". Every local test
 * passed, because a personal token answers that call happily.
 */

interface FakeClientOptions {
  meResult?: (() => Promise<{ id: string } | undefined>) | undefined;
  runResult?: ((runId: string) => Promise<{ userId: string } | undefined>) | undefined;
  record?: unknown;
}

function fakeClient(opts: FakeClientOptions) {
  const getRecord = vi.fn(async (_key: string) =>
    opts.record === undefined ? undefined : { value: opts.record },
  );

  const client = {
    user: () => ({
      get:
        opts.meResult ??
        (async () => {
          throw new Error('Insufficient permissions.');
        }),
    }),
    run: (runId: string) => ({
      get: opts.runResult === undefined ? async () => undefined : () => opts.runResult!(runId),
    }),
    keyValueStore: () => ({ getRecord }),
  } as unknown as ApifyClient;

  return { client, getRecord };
}

const HMAC = 'test-hmac-key';

describe('resolving who is running the Actor', () => {
  it('asks the platform whose token this is, when the token can answer', async () => {
    const { client, getRecord } = fakeClient({
      meResult: async () => ({ id: 'user-from-token' }),
      record: { paid: true },
    });

    const record = await createEntitlementLookup({
      client,
      storeId: 'store',
      hmacKey: HMAC,
      actorRunId: 'run-1',
    })();

    expect(record).toEqual({ paid: true });
    expect(getRecord).toHaveBeenCalledWith(entitlementKeyFor('user-from-token', HMAC));
  });

  it('falls back to the run owner when a scoped token is refused by /users/me', async () => {
    const { client, getRecord } = fakeClient({
      runResult: async () => ({ userId: 'owner-of-the-run' }),
      record: { paid: true },
    });

    const record = await createEntitlementLookup({
      client,
      storeId: 'store',
      hmacKey: HMAC,
      actorRunId: 'run-1',
    })();

    // Still an answer from the API about a platform resource — not a claim read out of
    // an environment variable.
    expect(record).toEqual({ paid: true });
    expect(getRecord).toHaveBeenCalledWith(entitlementKeyFor('owner-of-the-run', HMAC));
  });

  it('uses the run id only to name a resource — a forged one fails closed', async () => {
    // A run-scoped token may read its own run and nothing else, so pointing the env var
    // at somebody else's run is refused rather than granting their entitlement.
    const { client } = fakeClient({
      runResult: async () => {
        throw new Error('Insufficient permissions.');
      },
    });

    await expect(
      createEntitlementLookup({
        client,
        storeId: 'store',
        hmacKey: HMAC,
        actorRunId: 'someone-elses-run',
      })(),
    ).rejects.toThrow(/Insufficient permissions/);
  });

  it('throws when neither route is available, so the verdict fails closed', async () => {
    const { client } = fakeClient({});

    await expect(
      createEntitlementLookup({ client, storeId: 'store', hmacKey: HMAC })(),
    ).rejects.toThrow(/could not resolve the runner identity|Insufficient permissions/);
  });

  it('treats a run with no owner as unresolvable rather than guessing', async () => {
    const { client } = fakeClient({ runResult: async () => undefined });

    await expect(
      createEntitlementLookup({ client, storeId: 'store', hmacKey: HMAC, actorRunId: 'run-1' })(),
    ).rejects.toThrow(/did not report an owner/);
  });

  it('returns null — not an error — when the user simply has no record', async () => {
    const { client } = fakeClient({ meResult: async () => ({ id: 'u1' }) });

    // An unprovisioned user is a definite free user, which is a different signal from a
    // failed lookup.
    await expect(
      createEntitlementLookup({ client, storeId: 'store', hmacKey: HMAC })(),
    ).resolves.toBeNull();
  });
});

describe('readEntitlementConfig', () => {
  it('requires both variables, so a half-configured deployment cannot read as configured', () => {
    expect(readEntitlementConfig({})).toBeNull();
    expect(readEntitlementConfig({ ENTITLEMENTS_STORE_ID: 'store' })).toBeNull();
    expect(readEntitlementConfig({ ENTITLEMENTS_HMAC_KEY: 'key' })).toBeNull();
    expect(
      readEntitlementConfig({ ENTITLEMENTS_STORE_ID: '', ENTITLEMENTS_HMAC_KEY: 'key' }),
    ).toBeNull();
    expect(
      readEntitlementConfig({ ENTITLEMENTS_STORE_ID: 'store', ENTITLEMENTS_HMAC_KEY: 'key' }),
    ).toEqual({ storeId: 'store', hmacKey: 'key' });
  });
});

describe('entitlementKeyFor', () => {
  it('is stable and reveals nothing about the user', () => {
    const key = entitlementKeyFor('LVdLqrswA07ps0tgd', HMAC);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(entitlementKeyFor('LVdLqrswA07ps0tgd', HMAC));
    expect(key).not.toContain('LVdLqrswA07ps0tgd');
    expect(entitlementKeyFor('other-user', HMAC)).not.toBe(key);
    expect(entitlementKeyFor('LVdLqrswA07ps0tgd', 'different-key')).not.toBe(key);
  });
});
