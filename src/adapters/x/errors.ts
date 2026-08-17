/**
 * Error taxonomy (SPEC.md §5.2). The point of a taxonomy is that each signal maps to
 * exactly one action, decided once, here — not re-guessed at every call site.
 */

export type FailureAction =
  /** Burn this triple and continue on a fresh one. No waiting: a new token costs ~200 ms. */
  | 'rotate-session'
  /** Transient. Retry the same request after backoff with full jitter. */
  | 'retry'
  /** Our cached queryId may be stale after an X deploy. Refresh once, then retry. */
  | 'refresh-query-ids'
  /** This account is unreachable (protected/suspended/deleted). Skip it, keep the run. */
  | 'skip-target'
  /** Non-recoverable. Fail the run. */
  | 'fatal';

export interface Classification {
  readonly action: FailureAction;
  readonly reason: string;
  /** Bucket for the run summary's error counters (SPEC.md §7). */
  readonly counter: '429' | '403' | '404' | '5xx' | 'timeout' | 'other' | null;
}

export function classifyStatus(statusCode: number): Classification {
  if (statusCode >= 200 && statusCode < 300) {
    return { action: 'retry', reason: 'ok', counter: null };
  }

  // Rotating on 429 rather than sleeping is the single biggest throughput decision in
  // the design: the 15-minute window belongs to the *token*, and tokens are free.
  if (statusCode === 429) {
    return { action: 'rotate-session', reason: 'rate limited', counter: '429' };
  }

  // Classic guest-token expiry. The token, not the IP, is what went stale — but the
  // triple is retired whole, because splitting it is what breaks session coherence.
  if (statusCode === 403) {
    return { action: 'rotate-session', reason: 'guest token rejected', counter: '403' };
  }

  /**
   * 404 on an operation we know guests may call is ambiguous, and the two causes need
   * opposite responses:
   *   1. X redeployed and our cached queryId is stale  → refresh and retry
   *   2. the account is protected, suspended or deleted → terminal for that account
   * We try (1) once per run, then treat any further 404 as (2). Escalating in the other
   * order would spend the refresh budget on every protected account we meet.
   */
  if (statusCode === 404) {
    return { action: 'refresh-query-ids', reason: 'operation or target not found', counter: '404' };
  }

  if (statusCode >= 500) {
    return { action: 'retry', reason: `upstream ${statusCode}`, counter: '5xx' };
  }

  // 400, 422 and friends mean we built a bad request. Retrying cannot help.
  return { action: 'fatal', reason: `unrecoverable HTTP ${statusCode}`, counter: 'other' };
}

const TIMEOUT_MARKERS = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'];

export function classifyTransportError(err: unknown): Classification {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  if (TIMEOUT_MARKERS.some((marker) => message.includes(marker)) || /timeout/i.test(message)) {
    return { action: 'retry', reason: message, counter: 'timeout' };
  }
  // A dead proxy looks like a transport failure; rotating gets a different exit node.
  return { action: 'rotate-session', reason: message, counter: 'other' };
}

/** The target account cannot be read. Logged, counted, skipped — never fatal (brief §11). */
export class TargetUnavailableError extends Error {
  constructor(
    readonly handle: string,
    readonly kind: 'protected' | 'suspended' | 'not_found' | 'unknown',
    message?: string,
  ) {
    super(message ?? `@${handle} is unavailable (${kind})`);
    this.name = 'TargetUnavailableError';
  }
}

/** The run cannot continue: bad request shape, or a gate we cannot work around. */
export class XFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XFatalError';
  }
}

/**
 * Exponential backoff with **full jitter**: a uniform draw over `[0, window)` rather
 * than the window itself. Fixed backoff re-synchronises every failed worker onto the
 * same retry instant and reproduces the burst that caused the failure.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const window = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * window);
}
