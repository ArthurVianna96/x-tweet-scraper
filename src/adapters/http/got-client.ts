import { gotScraping } from 'got-scraping';

import { DEFAULT_TIMEOUT_MS, type HttpClient } from './client.js';

/**
 * The real transport: `got-scraping`, which gives us a browser-shaped TLS/HTTP2
 * fingerprint and header ordering without running a browser (brief §3).
 *
 * Header *generation* is switched off here on purpose. Headers are minted once per
 * session triple and pinned for its lifetime (SPEC.md §5.1) — regenerating them per
 * request would make a single guest token appear to be a different browser on every
 * call, which is exactly the incoherence X's abuse detection looks for.
 */
export function createGotClient(): HttpClient {
  return async (req) => {
    const response = await gotScraping({
      url: req.url,
      method: req.method ?? 'GET',
      headers: { ...req.headers },
      proxyUrl: req.proxyUrl,
      timeout: { request: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      // Status codes are data, not exceptions — see the port docs.
      throwHttpErrors: false,
      followRedirect: true,
      retry: { limit: 0 }, // retries are a policy decision, made in adapters/x/errors.ts
      responseType: 'text',
      useHeaderGenerator: false,
      http2: true,
    });

    return {
      statusCode: response.statusCode,
      body: response.body,
      headers: response.headers,
    };
  };
}
