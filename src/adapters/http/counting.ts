import type { HttpClient } from './client.js';

/**
 * Counts everything crossing the wire. It wraps the transport rather than living inside
 * `XClient` because the queryId bundle and the seed lookup also cross the paid proxy, and
 * a counter that saw only GraphQL calls would understate cost by more than it reported.
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
