import { describe, expect, it, vi } from 'vitest';

import type { HttpClient, HttpResponse } from '../http/client.js';
import {
  APIFY_SESSION_ID_PATTERN,
  REQUESTS_BEFORE_GROWING,
  RETIRE_AT_REMAINING,
  SessionPool,
  sessionId,
} from './session.js';

/** A transport that mints a distinct guest token per call and records the proxy used. */
function fakeHttp(): { http: HttpClient; proxies: (string | undefined)[]; calls: number } {
  const state = { calls: 0, proxies: [] as (string | undefined)[] };

  const http: HttpClient = async (req) => {
    state.calls++;
    state.proxies.push(req.proxyUrl);
    return {
      statusCode: 200,
      body: JSON.stringify({ guest_token: `token-${state.calls}` }),
      headers: {},
    };
  };

  return {
    http,
    get proxies() {
      return state.proxies;
    },
    get calls() {
      return state.calls;
    },
  };
}

const response = (headers: Record<string, string>): HttpResponse => ({
  statusCode: 200,
  body: '{}',
  headers,
});

describe('session ids are valid for Apify Proxy', () => {
  it('contains no character Apify Proxy rejects', () => {
    // Apify Proxy validates against /^[\w._~]+$/ — no hyphens. A hyphenated id throws on
    // the first newUrl() call and fails the entire run before a single request. It cannot
    // be caught without a proxy, so the first deployed run was the first to see it.
    expect(sessionId(1, 'abc123')).toMatch(APIFY_SESSION_ID_PATTERN);
    expect(sessionId(42, 'z9q0x1')).toMatch(APIFY_SESSION_ID_PATTERN);
    expect('x-1-kwdg8n').not.toMatch(APIFY_SESSION_ID_PATTERN); // the id that failed
  });

  it('mints ids the proxy accepts for every session the pool creates', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({
      http,
      newProxyUrl: async (id) => {
        if (!APIFY_SESSION_ID_PATTERN.test(id)) throw new Error(`bad sessionId: ${id}`);
        return `http://proxy/${id}`;
      },
      maxSessions: 3,
    });

    for (let i = 0; i < REQUESTS_BEFORE_GROWING * 3; i++) {
      const session = await pool.acquire();
      pool.observe(session, response({ 'x-rate-limit-remaining': '40' }));
    }

    expect(pool.totalCreated).toBeGreaterThan(1);
  });
});

describe('session triples (SPEC.md §5.1)', () => {
  it('pins one token to one proxy session and one header set', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({
      http,
      newProxyUrl: async (sessionId) => `http://proxy/${sessionId}`,
      maxSessions: 5,
    });

    const session = await pool.acquire();

    // The triple is created together; coherence is the point — one token arriving from
    // twelve IPs is a pattern no browser produces.
    expect(session.guestToken).toBe('token-1');
    expect(session.proxyUrl).toBe(`http://proxy/${session.id}`);
    expect(session.headers['user-agent']).toBeTypeOf('string');

    const again = await pool.acquire();
    expect(again.headers).toBe(session.headers);
    expect(again.guestToken).toBe(session.guestToken);
  });

  it('does not mint a token per request', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 5 });

    for (let i = 0; i < REQUESTS_BEFORE_GROWING - 1; i++) {
      const session = await pool.acquire();
      pool.observe(session, response({ 'x-rate-limit-remaining': '40' }));
    }

    expect(pool.totalCreated).toBe(1);
  });

  it('collapses concurrent cold starts into one token', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 5 });

    // Four account chains starting at once must not each mint their own triple.
    const sessions = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);

    expect(pool.totalCreated).toBe(1);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(1);
  });

  it('grows the pool as request volume rises, up to maxSessions', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 2 });

    for (let i = 0; i < REQUESTS_BEFORE_GROWING * 4; i++) {
      const session = await pool.acquire();
      pool.observe(session, response({ 'x-rate-limit-remaining': '40' }));
    }

    expect(pool.totalCreated).toBe(2);
    expect(pool.liveCount).toBe(2);
  });

  it('retires a triple before it takes a 429', async () => {
    const { http } = fakeHttp();
    const retired = vi.fn();
    const pool = new SessionPool({
      http,
      newProxyUrl: async () => undefined,
      maxSessions: 3,
      onEvent: (event) => {
        if (event.type === 'retired') retired(event.reason);
      },
    });

    const session = await pool.acquire();
    pool.observe(session, response({ 'x-rate-limit-remaining': String(RETIRE_AT_REMAINING + 1) }));
    expect(session.retired).toBe(false);

    // Proactive budgeting: retire at the threshold so the 429 is never actually taken,
    // and the run summary can report `429: 0`.
    pool.observe(session, response({ 'x-rate-limit-remaining': String(RETIRE_AT_REMAINING) }));
    expect(session.retired).toBe(true);
    expect(retired).toHaveBeenCalledOnce();

    const replacement = await pool.acquire();
    expect(replacement.id).not.toBe(session.id);
    expect(pool.totalCreated).toBe(2);
  });

  it('tracks the rate-limit reset for observability', async () => {
    const { http } = fakeHttp();
    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 1 });

    const session = await pool.acquire();
    pool.observe(
      session,
      response({ 'x-rate-limit-remaining': '42', 'x-rate-limit-reset': '1786680533' }),
    );

    expect(session.remaining).toBe(42);
    expect(session.resetAt).toBe(1786680533);
    expect(session.requestsMade).toBe(1);
  });

  it('surfaces a failed guest-token mint rather than returning a broken session', async () => {
    const http: HttpClient = async () => ({ statusCode: 503, body: '', headers: {} });
    const pool = new SessionPool({ http, newProxyUrl: async () => undefined, maxSessions: 1 });

    await expect(pool.acquire()).rejects.toThrow(/guest\/activate failed: HTTP 503/);
  });
});
