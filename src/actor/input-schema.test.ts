import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ActorInputSchema } from './input.js';

/**
 * `.actor/input_schema.json` is data, so TypeScript cannot check it and the test suite
 * previously did not either. That gap shipped a schema the platform rejects: Apify
 * requires a `description` on every field, `maxAccounts` had none, and both `apify run`
 * and the platform build fail on it. Nothing else in the repo would have noticed.
 */

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.actor/input_schema.json',
);

interface Field {
  title?: string;
  description?: string;
  type?: string;
  editor?: string;
  enum?: string[];
  enumTitles?: string[];
  maximum?: number;
  default?: unknown;
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  title: string;
  type: string;
  schemaVersion: number;
  properties: Record<string, Field>;
};

const fields = Object.entries(schema.properties);

/**
 * `ActorInputSchema` is a `ZodObject` wrapped in two `.refine()` calls, so its shape sits
 * two `ZodEffects` deep. Unwrap until we reach the object rather than reaching through a
 * fixed number of layers, which silently returns `undefined` if a refinement is ever
 * added or removed — and an empty shape makes these comparisons pass vacuously.
 */
function objectShapeOf(schema_: unknown): Record<string, unknown> {
  let current = schema_ as { _def?: { schema?: unknown; shape?: unknown }; shape?: unknown };

  for (let depth = 0; depth < 10; depth++) {
    if (typeof current.shape === 'object' && current.shape !== null) {
      return current.shape as Record<string, unknown>;
    }
    const inner = current._def?.schema;
    if (inner === undefined) break;
    current = inner as typeof current;
  }

  throw new Error('could not reach the ZodObject shape');
}

describe('.actor/input_schema.json', () => {
  it('is a well-formed Apify input schema', () => {
    expect(schema.schemaVersion).toBe(1);
    expect(schema.type).toBe('object');
    expect(fields.length).toBeGreaterThan(0);
  });

  it.each(fields)('%s has the title, description and editor Apify requires', (_name, field) => {
    // The platform rejects the build otherwise — this is the check that was missing.
    expect(field.title, 'missing title').toBeTruthy();
    expect(field.description, 'missing description').toBeTruthy();
    expect(field.type, 'missing type').toBeTruthy();
    expect(field.editor, 'missing editor').toBeTruthy();
  });

  it.each(fields.filter(([, field]) => field.enum !== undefined))(
    '%s labels every enum value',
    (_name, field) => {
      expect(field.enumTitles).toHaveLength(field.enum?.length ?? 0);
    },
  );

  it('never caps maxResults in the schema', () => {
    // A `"maximum": 10` here would be a client-side limit, which brief §6 rejects as
    // protection, and it would break paying users. The gate is server-side, on purpose.
    expect(schema.properties['maxResults']?.maximum).toBeUndefined();
    expect(schema.properties['maxResults']?.description).toMatch(/free/i);
  });

  it('agrees with the zod schema on which fields exist', () => {
    // Two declarations of the same contract drift silently: a field added to the Console
    // form but not to zod is ignored at runtime, and the user is never told why their
    // setting did nothing.
    const zodFields = Object.keys(objectShapeOf(ActorInputSchema));
    const schemaFields = fields.map(([name]) => name);

    expect(schemaFields.filter((name) => !zodFields.includes(name))).toEqual([]);
    expect(zodFields.filter((name) => !schemaFields.includes(name))).toEqual([]);
  });

  it('agrees with the zod schema on defaults', () => {
    const parsed = ActorInputSchema.parse({ fromUsers: ['someone'] });

    for (const [name, field] of fields) {
      if (field.default === undefined) continue;
      if (name === 'proxyConfiguration') continue; // object default, compared structurally elsewhere
      expect((parsed as unknown as Record<string, unknown>)[name], `${name} default`).toEqual(
        field.default,
      );
    }
  });
});
