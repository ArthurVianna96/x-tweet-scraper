import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Committed real payloads, captured by `src/tools/capture-fixtures.ts`.
 *
 * Deterministic and offline by design (SPEC.md §8). The known cost: a fixture cannot
 * notice X changing its response shape, so these tests stay green while production
 * breaks. The production answer is a scheduled non-blocking contract test against the
 * live API; it is out of scope here and stated as a limitation in the README.
 */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

/** Curated single-tweet fixtures are wrapped with capture provenance. */
export function loadTweet(name: string): unknown {
  const fixture = loadFixture(name) as { tweet: unknown };
  return fixture.tweet;
}
