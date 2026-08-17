/**
 * Provisioning helper: works out which key a user's entitlement record belongs under,
 * and can write it.
 *
 *   npx tsx src/tools/entitlement-key.ts key <userId>      # print the key only
 *   npx tsx src/tools/entitlement-key.ts grant <userId>    # write { paid: true }
 *   npx tsx src/tools/entitlement-key.ts revoke <userId>   # write { paid: false }
 *   npx tsx src/tools/entitlement-key.ts check <userId>    # read the current record
 *
 * Reads `ENTITLEMENTS_HMAC_KEY`, `ENTITLEMENTS_STORE_ID` and `APIFY_TOKEN` from the
 * environment (see `.env.example`). It derives the key with the *same* function the gate
 * uses, so the two cannot drift.
 *
 * The token here must be **yours**, not a customer's: write access to the entitlements
 * store is the entire authority behind the gate (README §4.2).
 */
import { ApifyClient } from 'apify-client';

import { entitlementKeyFor, readEntitlementConfig } from '../adapters/entitlement/apify-kv.js';

type Action = 'key' | 'grant' | 'revoke' | 'check';

const USAGE = `usage: tsx src/tools/entitlement-key.ts <key|grant|revoke|check> <userId>

  key     print the store key for this user and exit (no network, no token needed)
  grant   write { paid: true } for this user
  revoke  write { paid: false } for this user
  check   read back whatever is stored for this user

env: ENTITLEMENTS_HMAC_KEY (required), ENTITLEMENTS_STORE_ID + APIFY_TOKEN (for all but 'key')
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const action = process.argv[2] as Action | undefined;
  const userId = process.argv[3];

  if (
    action === undefined ||
    userId === undefined ||
    !['key', 'grant', 'revoke', 'check'].includes(action)
  ) {
    fail(USAGE);
  }

  const hmacKey = process.env['ENTITLEMENTS_HMAC_KEY'];
  if (typeof hmacKey !== 'string' || hmacKey.length === 0) {
    fail('ENTITLEMENTS_HMAC_KEY is not set — see .env.example');
  }

  const key = entitlementKeyFor(userId, hmacKey);

  if (action === 'key') {
    process.stdout.write(`${key}\n`);
    return;
  }

  const config = readEntitlementConfig(process.env);
  if (config === null) fail('ENTITLEMENTS_STORE_ID is not set — see .env.example');

  const token = process.env['APIFY_TOKEN'];
  if (typeof token !== 'string' || token.length === 0) {
    fail('APIFY_TOKEN is not set — writing to the entitlements store needs *your* token');
  }

  const store = new ApifyClient({ token }).keyValueStore(config.storeId);

  if (action === 'check') {
    const record = await store.getRecord(key);
    process.stdout.write(
      record === undefined
        ? `no record for ${userId} → this user is free\n`
        : `${JSON.stringify(record.value)}\n`,
    );
    return;
  }

  const paid = action === 'grant';

  /**
   * The record body must not contain the user id, or anything else identifying.
   *
   * The store is public-read by design (README §4.2) and the *key* is HMAC'd precisely so
   * a world-readable store leaks no customer IDs. Putting the plaintext id in the value
   * would hand back exactly what the HMAC was protecting.
   */
  await store.setRecord({ key, value: { paid, updatedAt: new Date().toISOString() } });

  process.stdout.write(
    `${paid ? 'granted' : 'revoked'} paid access for ${userId}\n` +
      `  store: ${config.storeId}\n  key:   ${key}\n`,
  );
}

await main();
