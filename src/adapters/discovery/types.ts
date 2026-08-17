/**
 * X gates every operation that turns a topic into accounts, so a keyword run needs one
 * lookup from elsewhere. This port keeps that the only non-X call in the system, and
 * everything downstream is native X that does not know which strategy ran.
 */
export interface DiscoveryStrategy {
  readonly name: string;
  discover(): Promise<DiscoveryResult>;
}

export interface DiscoveryResult {
  /** Without '@', in preference order. */
  readonly handles: readonly string[];
  readonly requests: number;
}
