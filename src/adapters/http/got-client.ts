import { gotScraping } from 'got-scraping';

import { DEFAULT_TIMEOUT_MS, type HttpClient } from './client.js';

/**
 * `got-scraping` gives a browser-shaped TLS/HTTP2 fingerprint without running a browser.
 *
 * Header generation is off on purpose: headers are minted once per session triple and
 * pinned, so that one guest token does not look like a different browser on every call.
 */
export function createGotClient(): HttpClient {
  return async (req) => {
    const response = await gotScraping({
      url: req.url,
      method: req.method ?? 'GET',
      headers: { ...req.headers },
      proxyUrl: req.proxyUrl,
      timeout: { request: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      // Status codes are data, not exceptions.
      throwHttpErrors: false,
      followRedirect: true,
      retry: { limit: 0 }, // retry policy belongs to adapters/x/errors
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
