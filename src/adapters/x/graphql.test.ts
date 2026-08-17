import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpResponse } from '../http/client.js';
import { TargetUnavailableError, XFatalError } from './errors.js';
import { XClient } from './graphql.js';
import { QueryIdResolver } from './query-ids.js';
import { SessionPool } from './session.js';

/**
 * Resilience: "the run must not hard-crash on a single 429 or 403."
 *
 * Everything is offline. The transport is a scripted list of responses, so each failure
 * mode is exercised deterministically rather than hoped for.
 */

const ok = (body: unknown): HttpResponse => ({
  statusCode: 200,
  body: JSON.stringify(body),
  headers: {},
});
const status = (code: number): HttpResponse => ({ statusCode: code, body: '', headers: {} });

/** Serves guest tokens and the queryId bundle, then plays a script for GraphQL calls. */
function harness(script: (HttpResponse | Error)[]) {
  const graphqlUrls: string[] = [];
  let scriptIndex = 0;

  const http: HttpClient = async (req) => {
    if (req.url.includes('guest/activate')) {
      return ok({ guest_token: `token-${Math.random()}` });
    }
    if (req.url.includes('x.com/explore')) {
      return {
        statusCode: 200,
        body: 'https://abs.twimg.com/responsive-web/client-web/main.abc.js',
        headers: {},
      };
    }
    if (req.url.includes('abs.twimg.com')) {
      return {
        statusCode: 200,
        body: 'e.exports={queryId:"QID1",operationName:"UserTweets",metadata:{featureSwitches:["f1"],fieldToggles:[]}}',
        headers: {},
      };
    }

    graphqlUrls.push(req.url);
    const next = script[scriptIndex++] ?? status(200);
    if (next instanceof Error) throw next;
    return next;
  };

  const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 5 });
  const queryIds = new QueryIdResolver(http, () => ({ headers: {} }));
  const client = new XClient({ http, pool, queryIds, sleep: async () => {}, random: () => 0 });

  return { client, pool, queryIds, graphqlUrls };
}

describe('XClient resilience', () => {
  it('survives a 429 by rotating to a fresh triple, not by waiting', async () => {
    const { client, pool } = harness([status(429), ok({ data: { ok: true } })]);

    const result = await client.call('UserTweets', {});

    expect(result).toEqual({ data: { ok: true } });
    expect(client.stats.errors['429']).toBe(1);
    // A second triple exists because the first was burned, not slept on.
    expect(pool.totalCreated).toBe(2);
  });

  it('survives a 403 by replacing the expired guest token', async () => {
    const { client, pool } = harness([status(403), ok({ data: {} })]);

    await expect(client.call('UserTweets', {})).resolves.toBeDefined();
    expect(client.stats.errors['403']).toBe(1);
    expect(pool.totalCreated).toBe(2);
  });

  it('retries a 5xx with backoff', async () => {
    const { client } = harness([status(503), status(500), ok({ data: {} })]);

    await expect(client.call('UserTweets', {})).resolves.toBeDefined();
    expect(client.stats.errors['5xx']).toBe(2);
  });

  it('retries a socket timeout', async () => {
    const { client } = harness([new Error('connect ETIMEDOUT'), ok({ data: {} })]);

    await expect(client.call('UserTweets', {})).resolves.toBeDefined();
    expect(client.stats.errors.timeout).toBe(1);
  });

  it('refreshes queryIds once on a 404, then treats the target as unavailable', async () => {
    const { client } = harness([status(404), status(404), status(404), status(404)]);

    // First 404 → "maybe X redeployed", refresh and retry. Second → the account is gone.
    await expect(client.call('UserTweets', {}, { target: 'someone' })).rejects.toBeInstanceOf(
      TargetUnavailableError,
    );
  });

  it('treats a persistent 404 with no target as a gated operation, which is fatal', async () => {
    const { client } = harness([status(404), status(404)]);

    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(XFatalError);
  });

  it('fails fast on a malformed request rather than retrying it', async () => {
    const { client, graphqlUrls } = harness([status(400), ok({ data: {} })]);

    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(XFatalError);
    // Retrying a request we built wrong cannot help, so exactly one was sent.
    expect(graphqlUrls).toHaveLength(1);
  });

  it('gives up after the attempt budget instead of looping forever', async () => {
    const { client } = harness([status(503), status(503), status(503), status(503), status(503)]);

    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(XFatalError);
    expect(client.stats.requests).toBe(4);
  });

  it('sends the queryId and feature switches read from the live bundle', async () => {
    const { client, graphqlUrls } = harness([ok({ data: {} })]);

    await client.call('UserTweets', { userId: '42' });

    const url = graphqlUrls[0] ?? '';
    expect(url).toContain('/graphql/QID1/UserTweets');
    expect(decodeURIComponent(url)).toContain('"f1":true');
    expect(decodeURIComponent(url)).toContain('"userId":"42"');
  });

  it('rejects a non-JSON body rather than passing garbage downstream', async () => {
    const { client } = harness([{ statusCode: 200, body: '<html>login</html>', headers: {} }]);

    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(XFatalError);
  });

  it('counts bytes for the cost estimate', async () => {
    const { client } = harness([ok({ data: { a: 1 } })]);

    await client.call('UserTweets', {});
    expect(client.stats.bytes).toBeGreaterThan(0);
  });
});

/**
 * Cold start is not exempt from the taxonomy.
 *
 * Found on the Apify platform, not in a test: one benchmark run in three died with
 * "Client network socket disconnected before secure TLS connection was established"
 * during the queryId bundle fetch. The bundle fetch and the guest-token mint are
 * ordinary HTTP over the same paid proxy, and they ran *outside* the retry loop, so a
 * single transport blip failed the whole run — which the spec and the spec forbid.
 */
describe('cold-start transport failures are retried, not fatal', () => {
  /** Fails the first `failures` attempts at `match`, then serves normally. */
  function flaky(match: string, failures: number) {
    let seen = 0;
    const http: HttpClient = async (req) => {
      if (req.url.includes(match) && seen++ < failures) {
        throw new Error(
          'Client network socket disconnected before secure TLS connection was established',
        );
      }
      if (req.url.includes('guest/activate')) return ok({ guest_token: 'tok' });
      if (req.url.includes('x.com/explore')) {
        return {
          statusCode: 200,
          body: 'https://abs.twimg.com/responsive-web/client-web/main.abc.js',
          headers: {},
        };
      }
      if (req.url.includes('abs.twimg.com')) {
        return {
          statusCode: 200,
          body: 'e.exports={queryId:"QID1",operationName:"UserTweets",metadata:{featureSwitches:[],fieldToggles:[]}}',
          headers: {},
        };
      }
      return ok({ data: { ok: true } });
    };

    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 5 });
    const queryIds = new QueryIdResolver(http, () => ({ headers: {} }));
    return new XClient({ http, pool, queryIds, sleep: async () => {}, random: () => 0 });
  }

  it('survives a TLS failure while fetching the queryId bundle', async () => {
    const client = flaky('abs.twimg.com', 1);
    await expect(client.call('UserTweets', {}, { target: 'apify' })).resolves.toEqual({
      data: { ok: true },
    });
  });

  it('survives a TLS failure while minting the first guest token', async () => {
    const client = flaky('guest/activate', 1);
    await expect(client.call('UserTweets', {}, { target: 'apify' })).resolves.toEqual({
      data: { ok: true },
    });
  });

  it('still gives up rather than looping forever when cold start never recovers', async () => {
    const client = flaky('abs.twimg.com', 99);
    await expect(client.call('UserTweets', {}, { target: 'apify' })).rejects.toThrow(
      TargetUnavailableError,
    );
  });
});
