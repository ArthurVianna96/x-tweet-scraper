import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Committed real payloads, captured by `src/tools/capture-fixtures.ts`.
 *
 * Deterministic and offline by design. The cost: a fixture cannot notice X changing its
 * response shape, so these tests stay green while production breaks.
 */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

/** Curated single-tweet fixtures are wrapped with capture provenance. */
export function loadTweet(name: string): unknown {
  const fixture = loadFixture(name) as { tweet: unknown };
  return fixture.tweet;
}
