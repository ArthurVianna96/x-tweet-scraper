import { HeaderGenerator } from 'header-generator';

import type { HttpClient, HttpResponse } from '../http/client.js';
import { GUEST_ACTIVATE_URL, PUBLIC_WEB_BEARER } from './constants.js';

/**
 * The session triple (SPEC.md §5.1): one guest token, one proxy IP, one browser header
 * set — created together, retired together.
 *
 * X's abuse detection looks for *coherence*. A real browser is one token on one IP with
 * one user-agent for the life of a session; one token arriving from twelve residential
 * IPs in ninety seconds is a pattern no browser produces. Pinning also bounds the damage
 * of a burned triple to 1/N of capacity, whereas hopping leaks the cross-product and
 * makes the whole pool linkable from a single observation.
 */
export interface XSession {
  readonly id: string;
  readonly guestToken: string;
  /** Pinned for the session's whole life. Regenerating per request is the bug. */
  readonly headers: Readonly<Record<string, string>>;
  readonly proxyUrl: string | undefined;
  requestsMade: number;
  /** From `x-rate-limit-remaining`; `null` until the first response is seen. */
  remaining: number | null;
  /** From `x-rate-limit-reset`, epoch seconds. */
  resetAt: number | null;
  retired: boolean;
  retiredReason: string | null;
}

/**
 * Retire a triple while it still has requests left, so a 429 is never actually taken.
 * Proactive budgeting beats reactive backoff: the run summary should report `429: 0`
 * (SPEC.md §5.2).
 */
export const RETIRE_AT_REMAINING = 5;

/** How many requests a triple serves before the pool adds another. See `acquire`. */
export const REQUESTS_BEFORE_GROWING = 10;

const headerGenerator = new HeaderGenerator({
  browsers: [{ name: 'chrome', minVersion: 120 }],
  devices: ['desktop'],
  operatingSystems: ['macos', 'windows'],
  locales: ['en-US', 'en'],
});

export function generateBrowserHeaders(): Record<string, string> {
  return headerGenerator.getHeaders();
}

/** X-specific headers layered onto the session's pinned browser headers. */
export function xApiHeaders(session: XSession): Record<string, string> {
  return {
    ...session.headers,
    authorization: `Bearer ${PUBLIC_WEB_BEARER}`,
    'x-guest-token': session.guestToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    accept: '*/*',
    referer: 'https://x.com/',
  };
}

export async function mintGuestToken(
  http: HttpClient,
  opts: { headers: Readonly<Record<string, string>>; proxyUrl?: string | undefined },
): Promise<string> {
  const response = await http({
    url: GUEST_ACTIVATE_URL,
    method: 'POST',
    headers: { ...opts.headers, authorization: `Bearer ${PUBLIC_WEB_BEARER}` },
    proxyUrl: opts.proxyUrl,
  });

  if (response.statusCode !== 200) {
    throw new Error(`guest/activate failed: HTTP ${response.statusCode}`);
  }

  const token: unknown = JSON.parse(response.body)?.['guest_token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('guest/activate returned no guest_token');
  }
  return token;
}

export interface SessionPoolOptions {
  readonly http: HttpClient;
  /** Sticky proxy URL for a session id. Return `undefined` to run without a proxy. */
  readonly newProxyUrl: (sessionId: string) => Promise<string | undefined>;
  /** Upper bound on live triples. Each is worth ~50 requests / 15 min (SPEC.md §6). */
  readonly maxSessions: number;
  readonly onEvent?: (event: SessionEvent) => void;
}

export type SessionEvent =
  | { readonly type: 'created'; readonly sessionId: string }
  | { readonly type: 'retired'; readonly sessionId: string; readonly reason: string };

/**
 * A pool of triples. Guest tokens are free and instant to mint, which is why the
 * response to a 429 is "rotate", not "wait": waiting fifteen minutes for a resource
 * that costs ~200 ms to replace is the largest throughput mistake available here.
 */
export class SessionPool {
  private readonly sessions: XSession[] = [];
  private created = 0;
  private cursor = 0;
  private creating: Promise<XSession> | null = null;

  constructor(private readonly opts: SessionPoolOptions) {}

  /** Total triples minted over the run — reported as `tokensConsumed` (SPEC.md §7). */
  get totalCreated(): number {
    return this.created;
  }

  get liveCount(): number {
    return this.sessions.filter((s) => !s.retired).length;
  }

  async acquire(): Promise<XSession> {
    this.evictRetired();

    const usable = this.sessions.filter(
      (session) => session.remaining === null || session.remaining > RETIRE_AT_REMAINING,
    );

    /**
     * The pool grows with demand, not with request count.
     *
     * Minting a fresh triple per request would be the opposite of the design: it hands X
     * a new token from a new IP on every call, which is the incoherence §5.1 exists to
     * avoid, and it wastes the 50-request budget each token comes with. So a triple
     * serves at least `REQUESTS_BEFORE_GROWING` requests before another is added, up to
     * `maxSessions`.
     */
    const shouldGrow =
      usable.length === 0 ||
      (this.sessions.length < this.opts.maxSessions &&
        this.requestsAcrossPool() >= this.sessions.length * REQUESTS_BEFORE_GROWING);

    if (shouldGrow) {
      // Collapse concurrent cold starts. Without this, N account chains starting at once
      // each see an empty pool and mint their own token — the exact per-request-token
      // behaviour the growth policy exists to prevent.
      this.creating ??= this.create().finally(() => {
        this.creating = null;
      });
      const session = await this.creating;
      if (!this.sessions.includes(session)) this.sessions.push(session);
      return session;
    }

    // Round-robin across live triples so no single token burns its budget first.
    const session = usable[this.cursor % usable.length];
    this.cursor++;
    if (session !== undefined) return session;

    const fresh = await this.create();
    this.sessions.push(fresh);
    return fresh;
  }

  private requestsAcrossPool(): number {
    return this.sessions.reduce((total, session) => total + session.requestsMade, 0);
  }

  /**
   * Feed every response back so the pool can budget proactively rather than discover
   * exhaustion by being refused.
   */
  observe(session: XSession, response: HttpResponse): void {
    session.requestsMade++;

    const remaining = numericHeader(response, 'x-rate-limit-remaining');
    const reset = numericHeader(response, 'x-rate-limit-reset');
    if (remaining !== null) session.remaining = remaining;
    if (reset !== null) session.resetAt = reset;

    if (session.remaining !== null && session.remaining <= RETIRE_AT_REMAINING) {
      this.retire(session, `rate-limit budget spent (${session.remaining} left)`);
    }
  }

  retire(session: XSession, reason: string): void {
    if (session.retired) return;
    session.retired = true;
    session.retiredReason = reason;
    this.opts.onEvent?.({ type: 'retired', sessionId: session.id, reason });
  }

  private async create(): Promise<XSession> {
    this.created++;
    const id = `x-${this.created}-${randomSuffix()}`;
    const headers = generateBrowserHeaders();
    const proxyUrl = await this.opts.newProxyUrl(id);
    const guestToken = await mintGuestToken(this.opts.http, { headers, proxyUrl });

    this.opts.onEvent?.({ type: 'created', sessionId: id });

    return {
      id,
      guestToken,
      headers,
      proxyUrl,
      requestsMade: 0,
      remaining: null,
      resetAt: null,
      retired: false,
      retiredReason: null,
    };
  }

  private evictRetired(): void {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i]?.retired === true) this.sessions.splice(i, 1);
    }
  }
}

function numericHeader(response: HttpResponse, name: string): number | null {
  const raw = response.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
