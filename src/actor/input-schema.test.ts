import { existsSync, readFileSync } from 'node:fs';
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

describe('.actor definition files', () => {
  const actorDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../.actor');
  const actorJson = JSON.parse(readFileSync(resolve(actorDir, 'actor.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('references only files that exist', () => {
    // Apify resolves these at build time; a dangling path fails the build, not the tests.
    const refs = [
      actorJson['input'],
      actorJson['output'],
      ...Object.values((actorJson['storages'] ?? {}) as Record<string, unknown>),
    ].filter((ref): ref is string => typeof ref === 'string');

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(resolve(actorDir, ref)), `${ref} is referenced but missing`).toBe(true);
    }
  });

  it('declares an output schema, which the Store requires before publishing', () => {
    // "Add Output schema(s) to the source code and rebuild" blocks publication otherwise.
    const output = JSON.parse(
      readFileSync(resolve(actorDir, 'output_schema.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(output['actorOutputSchemaVersion']).toBe(1);
    expect(output['title']).toBeTruthy();
    expect(Object.keys(output['properties'] as object).length).toBeGreaterThan(0);

    for (const field of Object.values(
      output['properties'] as Record<string, Field & { template?: string }>,
    )) {
      expect(field.title, 'output property needs a title').toBeTruthy();
      expect(field.template, 'output property needs a template').toBeTruthy();
    }
  });

  it('declares the key-value store collections a caller actually reads', () => {
    const kvs = JSON.parse(
      readFileSync(resolve(actorDir, 'key_value_store_schema.json'), 'utf8'),
    ) as {
      actorKeyValueStoreSchemaVersion: number;
      collections: Record<string, { key?: string; keyPrefix?: string; title?: string }>;
    };

    expect(kvs.actorKeyValueStoreSchemaVersion).toBe(1);
    for (const [name, collection] of Object.entries(kvs.collections)) {
      expect(collection.title, `${name} needs a title`).toBeTruthy();
      // Apify requires exactly one of key / keyPrefix.
      expect(
        (collection.key === undefined) !== (collection.keyPrefix === undefined),
        `${name} must set exactly one of key/keyPrefix`,
      ).toBe(true);
    }

    // The run summary is part of the documented output, so it must be declared.
    expect(Object.values(kvs.collections).some((c) => c.key === 'OUTPUT')).toBe(true);
  });

  it('keeps the Store listing metadata that publication requires', () => {
    expect(actorJson['title']).toBeTruthy();
    expect(actorJson['description']).toBeTruthy();
    expect((actorJson['categories'] as string[])?.length).toBeGreaterThan(0);
  });
});
