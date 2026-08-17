import { describe, expect, it } from 'vitest';

import { backoffDelayMs, classifyStatus, classifyTransportError } from './errors.js';

describe('error taxonomy', () => {
  it('rotates on 429 rather than waiting out the window', () => {
    // The 15-minute limit belongs to the *token*, and a token costs ~200ms to mint.
    // Sleeping instead of rotating is the largest throughput mistake available here.
    const classification = classifyStatus(429);
    expect(classification.action).toBe('rotate-session');
    expect(classification.counter).toBe('429');
  });

  it('rotates on 403 — the classic guest-token expiry', () => {
    expect(classifyStatus(403).action).toBe('rotate-session');
  });

  it('tries a queryId refresh on 404 before concluding the target is gone', () => {
    // 404 is ambiguous: stale queryId after an X deploy, or a dead account. Refreshing
    // first costs one request once per run; concluding "dead account" first would
    // silently drop every account after an X deploy.
    expect(classifyStatus(404).action).toBe('refresh-query-ids');
  });

  it('retries 5xx and treats 4xx request errors as fatal', () => {
    expect(classifyStatus(500).action).toBe('retry');
    expect(classifyStatus(503).counter).toBe('5xx');
    expect(classifyStatus(400).action).toBe('fatal');
    expect(classifyStatus(422).action).toBe('fatal');
  });

  it('retries socket timeouts and rotates on a dead proxy', () => {
    expect(classifyTransportError(new Error('connect ETIMEDOUT 1.2.3.4:443')).action).toBe('retry');
    expect(classifyTransportError(new Error('Timeout awaiting socket')).counter).toBe('timeout');
    expect(
      classifyTransportError(new Error('tunneling socket could not be established')).action,
    ).toBe('rotate-session');
  });

  it('handles a non-Error throw without crashing the classifier', () => {
    expect(classifyTransportError('boom').action).toBe('rotate-session');
  });
});

describe('backoff uses full jitter', () => {
  it('draws uniformly from [0, window) rather than sleeping the whole window', () => {
    // Fixed backoff re-synchronises every failed worker onto the same retry instant and
    // reproduces the burst that caused the failure.
    expect(backoffDelayMs(0, { baseMs: 1000, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(0, { baseMs: 1000, random: () => 0.999 })).toBe(999);
  });

  it('grows exponentially and stops at the cap', () => {
    const full = (attempt: number) =>
      backoffDelayMs(attempt, { baseMs: 500, capMs: 4000, random: () => 0.999999 });

    expect(full(0)).toBeLessThan(500);
    expect(full(1)).toBeLessThan(1000);
    expect(full(2)).toBeLessThan(2000);
    expect(full(10)).toBeLessThan(4000);
  });
});
