import type { DiscoveryResult, DiscoveryStrategy } from './types.js';

/**
 * `fromUsers` was supplied, so there is nothing to discover.
 *
 * This is the path on which the Actor is fully self-contained: no search engine, no
 * third party, nothing but X. It is the answer to the fair criticism of the seeded path,
 * which is that cold start has one external dependency.
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
