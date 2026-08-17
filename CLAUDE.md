# x-tweet-scraper — project conventions

Browserless X (Twitter) scraper, shipped as an Apify Actor. `SPEC.md` is the contract;
this file is only _how we write the code_. When the two disagree, `SPEC.md` wins.

## Layout

```
src/
  domain/    pure logic. No I/O, no Apify, no fetch. Fully unit-testable offline.
             normalizer · filters · result-sink · entitlement policy · snowflake
  adapters/  everything that talks to the outside world, behind a port defined in domain/
             x/ (guest tokens, queryIds, GraphQL) · discovery/ · entitlement/ · apify/
  actor/     the composition root: input parsing, wiring, run summary, main.
test/
  fixtures/  committed real X payloads. Deterministic, offline.
```

Dependency direction is one-way: `actor → adapters → domain`. `domain/` imports nothing
from the other two. If a domain module needs an effect, it takes it as a constructor
argument or a function parameter — never an import.

## Rules

- **TypeScript strict**, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. No `any`
  crossing a public boundary. Untrusted JSON enters as `unknown` and is narrowed.
- **Zod at every boundary** — Actor input, entitlement records. Not on X payloads: those
  are wide, deep and change without notice, so the normalizer reads them defensively by
  path and emits `null` for anything absent (see `SPEC.md` §3.2).
- **Named exports only.** No default exports.
- **Seam = constructor injection** (`SPEC.md` §8). No DI container, no module mocking.
  A unit test constructs the thing with fakes and asserts. `vi.mock` is a smell here.
- **`null` is the absent value** in Actor output. Never `undefined`, never omitted.
- Tests are colocated: `foo.ts` → `foo.test.ts`. Fixtures live in `test/fixtures/`.
- Comments explain _why_, and are reserved for decisions a reader would otherwise
  reverse. The load-bearing ones are cross-referenced to `SPEC.md` sections.
- Conventional commits, one atomic commit per build step.

## Commands

|                                   |                                                                  |
| --------------------------------- | ---------------------------------------------------------------- |
| `npm test`                        | Vitest, offline, no platform                                     |
| `npm run typecheck`               | `tsc --noEmit`                                                   |
| `npm run lint` / `npm run format` | eslint / prettier                                                |
| `npm run start:dev`               | run the Actor locally via tsx                                    |
| `npm run probe`                   | reproduce the endpoint capability matrix (~20 s, no credentials) |
