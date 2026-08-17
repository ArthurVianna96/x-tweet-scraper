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
      const session = await this.opts.pool.acquire();
      const meta = await this.opts.queryIds.get(operationName);

      const query = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(meta.features),
        fieldToggles: JSON.stringify(meta.fieldToggles),
      });
      const url = `${GRAPHQL_BASE}/${meta.queryId}/${operationName}?${query.toString()}`;

      this.stats.requests++;
      this.opts.onEvent?.({ type: 'request', operation: operationName, attempt });

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

      this.opts.pool.observe(session, response);
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
