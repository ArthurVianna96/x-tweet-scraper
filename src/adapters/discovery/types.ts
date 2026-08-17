/**
 * Discovery is a **port** (SPEC.md §2), and that is the whole architectural point.
 *
 * X gates every operation that turns a topic into accounts — search, typeahead, Explore,
 * trends, and the entire social graph all return 404 to a guest token. So a keyword run
 * needs one cold-start lookup from somewhere else, and isolating it behind this
 * interface keeps that the *only* non-X call in the system:
 *
 *   - `DirectHandleDiscovery` — `fromUsers` was supplied; zero external calls.
 *   - `SeededTopicDiscovery`  — one search-engine lookup per topic term. [default]
 *
 * A third strategy — index the web for tweet URLs and hydrate them by id — was built,
 * measured and rejected before it shipped (README §2).
 *
 * Everything downstream — resolution, paging, normalization, filtering, the gate — is
 * 100% native X and does not know which strategy ran.
 */
export interface DiscoveryStrategy {
  readonly name: string;
  discover(): Promise<DiscoveryResult>;
}

export interface DiscoveryResult {
  /** Candidate handles, without '@'. Order is preference order. */
  readonly handles: readonly string[];
  /** External requests spent. Reported in the run summary so the cost is visible. */
  readonly requests: number;
}
