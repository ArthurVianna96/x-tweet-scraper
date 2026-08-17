import type { HttpClient } from '../http/client.js';
import { GRAPHQL_BASE } from './constants.js';
import {
  TargetUnavailableError,
  XFatalError,
  backoffDelayMs,
  classifyStatus,
  classifyTransportError,
  type Classification,
} from './errors.js';
import type { QueryIdResolver } from './query-ids.js';
import type { SessionPool } from './session.js';
import { xApiHeaders } from './session.js';

export interface XClientEvent {
  readonly type: 'request' | 'recovered';
  readonly operation: string;
  readonly attempt: number;
  readonly statusCode?: number;
  readonly action?: string;
  readonly reason?: string;
}

export interface XClientStats {
  requests: number;
  /** Response bytes over the wire — the input to the proxy-cost estimate (SPEC.md §7). */
  bytes: number;
  errors: Record<'429' | '403' | '404' | '5xx' | 'timeout' | 'other', number>;
}

export interface XClientOptions {
  readonly http: HttpClient;
  readonly pool: SessionPool;
  readonly queryIds: QueryIdResolver;
  /** Total attempts per request, covering both rotations and backoff retries. */
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Injected so the slow-exit-node policy is testable without a slow test. */
  readonly now?: () => number;
  readonly onEvent?: (event: XClientEvent) => void;
}

/**
 * The resilient GraphQL caller: session pool + runtime queryIds + the §5.2 taxonomy,
 * joined in one place so no call site has to know what a 429 means.
 *
 * A single request never fails the run. Exhausting the attempt budget on one account
 * raises `TargetUnavailableError`, which the crawl counts and skips (brief §11).
 */
export class XClient {
  readonly stats: XClientStats = {
    requests: 0,
    bytes: 0,
    errors: { '429': 0, '403': 0, '404': 0, '5xx': 0, timeout: 0, other: 0 },
  };

  constructor(private readonly opts: XClientOptions) {}

  async call(
    operationName: string,
    variables: Readonly<Record<string, unknown>>,
    context: { target?: string } = {},
  ): Promise<unknown> {
    const maxAttempts = this.opts.maxAttempts ?? 4;
    const sleep = this.opts.sleep ?? defaultSleep;
    let last: Classification | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      /**
       * Cold start is inside the retry loop, not before it.
       *
       * Minting a guest token and fetching the ~1.8 MB queryId bundle are ordinary HTTP
       * over the same paid proxy as everything else, and they fail the same ways. With
       * these two calls outside the loop, a single transport blip escaped the taxonomy
       * and failed the whole run — observed on the platform as "Client network socket
       * disconnected before secure TLS connection was established" during the bundle
       * fetch, which brief §3 and §7 rule out (SPEC.md §5.2).
       */
      let session;
      let meta;
      try {
        session = await this.opts.pool.acquire();
        meta = await this.opts.queryIds.get(operationName);
      } catch (err) {
        last = classifyTransportError(err);
        this.count(last);
        this.opts.onEvent?.({
          type: 'request',
          operation: operationName,
          attempt,
          action: 'retry-cold-start',
          reason: last.reason,
        });
        await sleep(backoffDelayMs(attempt, { random: this.opts.random }));
        continue;
      }

      const query = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(meta.features),
        fieldToggles: JSON.stringify(meta.fieldToggles),
      });
      const url = `${GRAPHQL_BASE}/${meta.queryId}/${operationName}?${query.toString()}`;

      this.stats.requests++;
      this.opts.onEvent?.({ type: 'request', operation: operationName, attempt });

      const now = this.opts.now ?? Date.now;
      const sentAt = now();

      let response;
      try {
        response = await this.opts.http({
          url,
          headers: xApiHeaders(session),
          proxyUrl: session.proxyUrl,
        });
      } catch (err) {
        last = classifyTransportError(err);
        this.count(last);
        if (last.action === 'rotate-session') {
          this.opts.pool.retire(session, last.reason);
        } else {
          await sleep(backoffDelayMs(attempt, { random: this.opts.random }));
        }
        continue;
      }

      // Latency is fed back so the pool can retire a slow exit node, not just a
      // rate-limited one — the difference between one slow page and one slow run.
      this.opts.pool.observe(session, response, now() - sentAt);
      this.stats.bytes += response.body.length;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (attempt > 0) {
          this.opts.onEvent?.({ type: 'recovered', operation: operationName, attempt });
        }
        return parseJson(response.body, operationName);
      }

      last = classifyStatus(response.statusCode);
      this.count(last);
      this.opts.onEvent?.({
        type: 'request',
        operation: operationName,
        attempt,
        statusCode: response.statusCode,
        action: last.action,
        reason: last.reason,
      });

      switch (last.action) {
        case 'rotate-session':
          this.opts.pool.retire(session, last.reason);
          break;

        case 'refresh-query-ids': {
          // One refresh per run buys us the "X redeployed" explanation. After that a
          // 404 means the target is gone, not that our queryId is stale (§5.2).
          const refreshed = await this.opts.queryIds.refresh();
          if (!refreshed) {
            throw context.target === undefined
              ? new XFatalError(`${operationName} is gated for guests (404 after queryId refresh)`)
              : new TargetUnavailableError(context.target, 'unknown', `404 on ${operationName}`);
          }
          break;
        }

        case 'retry':
          await sleep(backoffDelayMs(attempt, { random: this.opts.random }));
          break;

        case 'skip-target':
          throw new TargetUnavailableError(context.target ?? operationName, 'unknown', last.reason);

        case 'fatal':
          throw new XFatalError(`${operationName}: ${last.reason}`);
      }
    }

    const reason = last?.reason ?? 'unknown';
    if (context.target !== undefined) {
      throw new TargetUnavailableError(
        context.target,
        'unknown',
        `gave up after retries: ${reason}`,
      );
    }
    throw new XFatalError(`${operationName} failed after ${maxAttempts} attempts: ${reason}`);
  }

  private count(classification: Classification): void {
    if (classification.counter !== null) this.stats.errors[classification.counter]++;
  }
}

function parseJson(body: string, operationName: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new XFatalError(`${operationName} returned a non-JSON body (${body.length} bytes)`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
