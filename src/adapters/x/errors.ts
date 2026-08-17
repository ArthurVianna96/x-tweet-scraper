/** Each signal maps to one action, decided here rather than at every call site. */

export type FailureAction =
  /** Burn this triple and continue on a fresh one; a new token costs ~200 ms. */
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
  /** Bucket for the run summary's error counters. */
  readonly counter: '429' | '403' | '404' | '5xx' | 'timeout' | 'other' | null;
}

export function classifyStatus(statusCode: number): Classification {
  if (statusCode >= 200 && statusCode < 300) {
    return { action: 'retry', reason: 'ok', counter: null };
  }

  // The 15-minute window belongs to the token, and tokens are free.
  if (statusCode === 429) {
    return { action: 'rotate-session', reason: 'rate limited', counter: '429' };
  }

  // Guest-token expiry. The triple retires whole; splitting it breaks coherence.
  if (statusCode === 403) {
    return { action: 'rotate-session', reason: 'guest token rejected', counter: '403' };
  }

  /**
   * Ambiguous, and the two causes need opposite responses: a stale queryId after an X
   * deploy, or a target that is gone. We try the refresh once per run, then assume the
   * latter — the other order spends the refresh on every protected account we meet.
   */
  if (statusCode === 404) {
    return { action: 'refresh-query-ids', reason: 'operation or target not found', counter: '404' };
  }

  if (statusCode >= 500) {
    return { action: 'retry', reason: `upstream ${statusCode}`, counter: '5xx' };
  }

  // 400, 422 and friends mean we built a bad request; retrying cannot help.
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

/** The target cannot be read. Logged, counted, skipped — never fatal. */
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
 * Full jitter: a uniform draw over `[0, window)`. Fixed backoff re-synchronises every
 * failed worker onto the same instant and reproduces the burst that caused the failure.
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
