import type { HttpClient } from './client.js';

/**
 * Wraps the transport to count everything that crosses the wire.
 *
 * It sits at the composition root rather than inside `XClient` on purpose: the ~10 MB
 * frontend bundle we parse for queryIds and the search-engine lookup both go through a
 * proxy and both cost money. A byte counter that only saw GraphQL calls would understate
 * proxy cost by more than it reported (SPEC.md §7).
 */
export interface TransferStats {
  requests: number;
  bytes: number;
}

export function createCountingClient(inner: HttpClient): {
  client: HttpClient;
  stats: TransferStats;
} {
  const stats: TransferStats = { requests: 0, bytes: 0 };

  const client: HttpClient = async (req) => {
    stats.requests++;
    const response = await inner(req);
    stats.bytes += response.body.length;
    return response;
  };

  return { client, stats };
}
