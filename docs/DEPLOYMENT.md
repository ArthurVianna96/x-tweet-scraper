# Deploying and operating the gate

How to stand up your own copy of this Actor and provision paying customers. The _why_
behind all of it is in [`README.md` §5](../README.md#5-the-free-tier-you-cannot-edit-away);
this file is the runbook.

Nothing here is needed to run the Actor or the test suite. Without an entitlements store
every run resolves to `entitlement_unavailable` and caps at 10 results — the gate failing
closed, which is correct behaviour rather than a configuration error.

---

## 1. Configure the gate

Two environment variables drive it. `.env.example` documents both; copy it to `.env` for
local runs (gitignored, loaded automatically by `npm run start:dev`).

| Variable                | What it is                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `ENTITLEMENTS_STORE_ID` | `username/store-name` of a **public-read** key-value store that only your account can write |
| `ENTITLEMENTS_HMAC_KEY` | the authority behind the gate — `openssl rand -hex 32`                                      |

`ENTITLEMENTS_HMAC_KEY` **must be Secret on Apify**, because a published Actor's non-secret
environment variables are visible on its detail page — a plain env var would publish the
authority itself. To make that structural instead of a checkbox someone forgets,
`.actor/actor.json` references both through Apify's secret mechanism, so `apify push`
uploads them encrypted:

```bash
apify secrets add x-scraper-entitlements-store  your-username/x-scraper-entitlements
apify secrets add x-scraper-entitlements-hmac   "$(openssl rand -hex 32)"
apify push
```

Both secrets must exist locally before the first push, or it fails on the missing
reference.

---

## 2. Make the store public-read — and don't trust your own test of it

This is the one deployment step that fails silently. On Apify the setting is
`generalAccess`, not `isPublic`:

```bash
curl -X PUT "https://api.apify.com/v2/key-value-stores/<storeId>?token=<yourToken>" \
  -H 'content-type: application/json' \
  -d '{"generalAccess":"ANYONE_WITH_ID_CAN_READ"}'
```

Verify it the way a customer's run sees it — **with no token at all**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://api.apify.com/v2/key-value-stores/<storeId>/records/__nope__"
# 404 → public-read, good.   403 → still private.
```

Why the check matters: inside a run, `APIFY_TOKEN` belongs to the **runner**, so a private
store is unreachable from every customer's run and they all fall back to
`entitlement_unavailable` — capped at 10, paying or not. Your _own_ test runs would look
perfect throughout, because your token can read your own private store. **The bug is
invisible from the inside and total from the outside.**

Making the store world-readable costs nothing: keys are HMAC'd and values are
`{ paid, updatedAt }`, so the public key listing is a page of hashes that names nobody.

---

## 3. Grant paid access

Records are keyed by `HMAC-SHA256(userId, ENTITLEMENTS_HMAC_KEY)`. `npm run entitlement`
derives that key with the _same function the gate uses_ — never recompute it by hand,
because a mismatch caps a paying customer with no error anywhere:

```bash
npm run entitlement -- grant  <userId>   # write { paid: true }
npm run entitlement -- check  <userId>   # read back what is stored
npm run entitlement -- revoke <userId>   # write { paid: false }
npm run entitlement -- key    <userId>   # just print the key (no network, no token)
```

`grant` / `revoke` / `check` write to the store, so they need **your** `APIFY_TOKEN` —
write access is the entire authority behind the gate. The record body deliberately
contains no user id: the key is HMAC'd precisely so a public store reveals nothing about
who is on it.

A `grant` or `revoke` is visible to the next run immediately; no caching was observed over
60 s.
