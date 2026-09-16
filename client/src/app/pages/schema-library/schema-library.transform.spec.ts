/**
 * Pure transform helpers behind "import a space-schema export into the library" (the fix for: a file
 * exported via the space Schema tab was NOT importable to the library). `extractTypeSchemas` detects
 * the space-export envelope vs a library-entry file; `entriesFromTypeSchemas` auto-groups a space's
 * typeSchemas into library entries, mirroring the server `export-space` naming so file-import and
 * live-space export produce identical entries.
 */
import { describe, it, expect } from 'vitest';
import { extractTypeSchemas, entriesFromTypeSchemas } from './schema-library.component';
import type { TypeSchema } from '../../core/api.types';

// A trimmed slice of a real space-schema export (karpathy-wiki), plus one $ref type to prove skipping.
const envelope = {
  spaceId: 'karpathy-wiki',
  spaceLabel: 'Karpathy-Style LLM Wiki',
  exportedAt: '2026-07-25T01:01:00.000Z',
  typeSchemas: {
    entity: {
      person: { namingPattern: "^[A-Za-z].{1,100}$", propertySchemas: { role: { type: 'string' } } },
      project: { propertySchemas: { status: { type: 'string', enum: ['active', 'archived'] } } },
      'linked-type': { $ref: 'library:some-shared-entry' }, // must be skipped
    },
    edge: { relatesTo: { propertySchemas: { note: { type: 'string' } } } },
    fact: { fact: { propertySchemas: { confidence: { type: 'string' } } } },
    chrono: { 'ingest-log': { propertySchemas: { trigger: { type: 'string', required: true } } } },
  },
} as unknown as { typeSchemas: Record<string, Record<string, TypeSchema>> };

describe('extractTypeSchemas', () => {
  it('returns the typeSchemas map from a { typeSchemas } export envelope', () => {
    const ts = extractTypeSchemas(envelope);
    expect(ts).not.toBeNull();
    expect(Object.keys(ts!)).toEqual(['entity', 'edge', 'fact', 'chrono']);
  });

  it('accepts a bare typeSchemas map (KT keys, no library-entry marker)', () => {
    const bare = { entity: { person: { propertySchemas: {} } } };
    expect(extractTypeSchemas(bare)).toBe(bare);
  });

  it('returns null for a single library-entry file (name+knowledgeType+schema)', () => {
    expect(extractTypeSchemas({ name: 'x', knowledgeType: 'entity', schema: {} })).toBeNull();
  });

  it('returns null for an array of library entries', () => {
    expect(extractTypeSchemas([{ name: 'x', knowledgeType: 'entity', schema: {} }])).toBeNull();
  });

  it('returns null for junk', () => {
    expect(extractTypeSchemas(null)).toBeNull();
    expect(extractTypeSchemas('nope')).toBeNull();
    expect(extractTypeSchemas({ foo: 1 })).toBeNull();
  });
});

describe('entriesFromTypeSchemas', () => {
  it('auto-groups every inline type, skipping $ref types', () => {
    const ts = extractTypeSchemas(envelope)!;
    const { entries, skippedRefs } = entriesFromTypeSchemas(ts, 'Karpathy-Style LLM Wiki');
    // person, project (entity) + relatesTo (edge) + fact (memory) + ingest-log (chrono) = 5; linked-type skipped.
    expect(entries).toHaveLength(5);
    expect(skippedRefs).toBe(1);
  });

  it('names entries <prefix>-<kt>-<typeName> (sanitised) and tags them with the group', () => {
    const ts = extractTypeSchemas(envelope)!;
    const { entries } = entriesFromTypeSchemas(ts, 'Karpathy-Style LLM Wiki');
    const person = entries.find(e => e.typeName === 'person')!;
    expect(person.name).toBe('karpathy-style-llm-wiki-entity-person');
    expect(person.knowledgeType).toBe('entity');
    expect(person.schemaGroup).toBe('Karpathy-Style LLM Wiki');
    // hyphenated type names survive; chrono kept
    expect(entries.find(e => e.typeName === 'ingest-log')!.name).toBe('karpathy-style-llm-wiki-chrono-ingest-log');
  });

  it('carries the type schema through unchanged', () => {
    const ts = extractTypeSchemas(envelope)!;
    const { entries } = entriesFromTypeSchemas(ts, 'g');
    const project = entries.find(e => e.typeName === 'project')!;
    expect(project.schema).toEqual({ propertySchemas: { status: { type: 'string', enum: ['active', 'archived'] } } });
  });

  it('is empty when there are no inline types', () => {
    expect(entriesFromTypeSchemas({}, 'g')).toEqual({ entries: [], skippedRefs: 0 });
  });
});
