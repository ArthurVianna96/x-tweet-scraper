/**
 * The HTTP port. Everything that leaves the process goes through this one function
 * type, so unit tests can supply a canned responder and stay offline (SPEC.md §8).
 *
 * It is deliberately status-code-transparent: a 404 or 429 is a *response*, not an
 * exception. The error taxonomy in `adapters/x/errors.ts` is the only place that
 * decides what a status means, and it cannot do that if the transport throws first.
 */
export interface HttpRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  /** Fully-formed proxy URL, e.g. from `ProxyConfiguration.newUrl(sessionId)`. */
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
