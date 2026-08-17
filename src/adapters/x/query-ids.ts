import type { HttpClient } from '../http/client.js';
import { BUNDLE_PAGE } from './constants.js';

/**
 * GraphQL `queryId`s rotate with every X frontend deploy, sometimes more than once a day,
 * so hardcoding them guarantees a silent 404 later. They are read at runtime from the
 * logged-out bundle and cached for the run.
 */
export interface OperationMeta {
  readonly queryId: string;
  readonly operationName: string;
  /** X rejects calls that omit a required flag. */
  readonly features: Readonly<Record<string, boolean>>;
  readonly fieldToggles: Readonly<Record<string, boolean>>;
}

export type OperationCatalog = ReadonlyMap<string, OperationMeta>;

const BUNDLE_URL_PATTERN = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js/g;

/** Webpack emits each operation as its own module, shaped like:
 *   `e.exports={queryId:"…",operationName:"…",metadata:{featureSwitches:[…],…}}` */
const OPERATION_PATTERN = /queryId:"([^"]+)",operationName:"([^"]+)"/g;

export function parseOperations(bundleSource: string): OperationCatalog {
  const catalog = new Map<string, OperationMeta>();

  for (const match of bundleSource.matchAll(OPERATION_PATTERN)) {
    const queryId = match[1];
    const operationName = match[2];
    if (queryId === undefined || operationName === undefined) continue;

    const objectStart = bundleSource.lastIndexOf('{', match.index);
    const literal =
      objectStart === -1 ? '' : (matchBalancedObject(bundleSource, objectStart) ?? '');

    catalog.set(operationName, {
      queryId,
      operationName,
      features: toFlagMap(literal.match(/featureSwitches:\[(.*?)\]/s)?.[1]),
      fieldToggles: toFlagMap(literal.match(/fieldToggles:\[(.*?)\]/s)?.[1]),
    });
  }

  return catalog;
}

export function findBundleUrl(html: string): string | null {
  const urls = [...new Set(html.match(BUNDLE_URL_PATTERN) ?? [])];
  return urls.find((url) => url.includes('/main.')) ?? null;
}

export interface CatalogFetchResult {
  readonly catalog: OperationCatalog;
  readonly bundleUrl: string;
}

export async function fetchOperationCatalog(
  http: HttpClient,
  opts: { headers: Readonly<Record<string, string>>; proxyUrl?: string | undefined },
): Promise<CatalogFetchResult> {
  const page = await http({ url: BUNDLE_PAGE, headers: opts.headers, proxyUrl: opts.proxyUrl });
  const bundleUrl = findBundleUrl(page.body);
  if (bundleUrl === null) {
    throw new Error(`No main.<hash>.js bundle in ${BUNDLE_PAGE} (HTTP ${page.statusCode})`);
  }

  const bundle = await http({ url: bundleUrl, headers: opts.headers, proxyUrl: opts.proxyUrl });
  const catalog = parseOperations(bundle.body);
  if (catalog.size === 0) {
    throw new Error(`Bundle ${bundleUrl} yielded no GraphQL operations`);
  }

  return { catalog, bundleUrl };
}

/**
 * One refresh allowed per run. A 404 means either a stale queryId after an X deploy or a
 * newly gated operation; refreshing once rules out the first, and a second 404 is fatal.
 */
export class QueryIdResolver {
  private catalog: OperationCatalog | null = null;
  private bundleUrl: string | null = null;
  private refreshed = false;
  private inFlight: Promise<CatalogFetchResult> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly headersFor: () => {
      headers: Readonly<Record<string, string>>;
      proxyUrl?: string | undefined;
    },
  ) {}

  get resolvedBundleUrl(): string | null {
    return this.bundleUrl;
  }

  async get(operationName: string): Promise<OperationMeta> {
    const catalog = this.catalog ?? (await this.load()).catalog;
    const meta = catalog.get(operationName);
    if (meta === undefined) {
      throw new Error(`Operation ${operationName} is absent from the logged-out bundle`);
    }
    return meta;
  }

  /** @returns false when the refresh budget is spent, which the caller treats as fatal. */
  async refresh(): Promise<boolean> {
    if (this.refreshed) return false;
    this.refreshed = true;
    this.catalog = null;
    await this.load();
    return true;
  }

  private async load(): Promise<CatalogFetchResult> {
    // Collapse concurrent cold starts, or N chains each pull the bundle through the proxy.
    this.inFlight ??= fetchOperationCatalog(this.http, this.headersFor()).finally(() => {
      this.inFlight = null;
    });

    const result = await this.inFlight;
    this.catalog = result.catalog;
    this.bundleUrl = result.bundleUrl;
    return result;
  }
}

/** Brace-match forward from `start` for one balanced `{…}` literal. */
function matchBalancedObject(source: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function toFlagMap(rawList: string | undefined): Record<string, boolean> {
  const names = [...(rawList ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return Object.fromEntries(
    names.filter((n): n is string => n !== undefined).map((n) => [n, true]),
  );
}
