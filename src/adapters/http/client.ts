/**
 * Everything that leaves the process goes through this one function type, so tests stay
 * offline with a canned responder.
 *
 * Status-code-transparent on purpose: a 404 or 429 is a response, not an exception,
 * because `adapters/x/errors` cannot classify what the transport already threw away.
 */
export interface HttpRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  /** Fully-formed, e.g. from `ProxyConfiguration.newUrl(sessionId)`. */
  readonly proxyUrl?: string | undefined;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export const DEFAULT_TIMEOUT_MS = 30_000;
