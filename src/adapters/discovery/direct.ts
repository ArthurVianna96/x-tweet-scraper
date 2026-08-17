import type { DiscoveryResult, DiscoveryStrategy } from './types.js';

/** `fromUsers` was supplied: nothing to discover, and nothing but X is contacted. */
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
