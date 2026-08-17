import type { DiscoveryResult, DiscoveryStrategy } from './types.js';

/**
 * `fromUsers` was supplied, so there is nothing to discover.
 *
 * This is the path that makes the Actor fully self-contained: no search engine, no third
 * party, nothing but X. It is worth naming in the README, because "one external
 * dependency at cold start" is a fair criticism of the seeded path and this is the
 * answer to it.
 */
export class DirectHandleDiscovery implements DiscoveryStrategy {
  readonly name = 'direct';

  constructor(private readonly handles: readonly string[]) {}

  async discover(): Promise<DiscoveryResult> {
    const cleaned = this.handles
      .map((handle) => handle.trim().replace(/^@/, ''))
      .filter((handle) => handle.length > 0);

    return { handles: [...new Set(cleaned)], requests: 0 };
  }
}
