/**
 * BrainStore — CHARACTERIZATION tests for the derived list state.
 *
 * Written against the unmodified 3701-line component BEFORE the A17.9 split, and landed as their own
 * PR. A characterization test only means anything if it was green against the ORIGINAL code; written
 * during a refactor it just proves the new code agrees with itself.
 *
 * The existing brain.component.spec.ts covers rendering (OnPush, the drawer, the network indicator).
 * It does not touch the pure derived state below — which is precisely what A17.9 relocates when the
 * eight tab-views become child components over a shared BrainState. So this pins:
 *
 *   - the `*TagSuggestions` union of schema suggestions + tags present on loaded records
 *   - `*TypeOptions`: schema names UNION values present, deduped and SORTED
 *
 * (No `filtered*` views remain to pin — every tab filters server-side since 4c-i; file-meta's old
 * client `filteredFileMetas` was removed with the top-bar client filter.)
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import type { ChronoEntry, Edge, Entity, Fact, SpaceMetaResponse } from '../../core/api.types';
import { BrainStore } from './brain-store.service';

const mem = (fact: string, over: Partial<Fact> = {}): Fact =>
  ({ _id: fact, fact, tags: [], createdAt: '', seq: 1, ...over } as Fact);
const ent = (name: string, over: Partial<Entity> = {}): Entity =>
  ({ _id: name, name, tags: [], createdAt: '', ...over } as Entity);
const edge = (label: string, over: Partial<Edge> = {}): Edge =>
  ({ _id: label, from: 'a', to: 'b', label, tags: [], createdAt: '', ...over } as Edge);
const chrono = (title: string, over: Partial<ChronoEntry> = {}): ChronoEntry =>
  ({ _id: title, title, type: 'event', tags: [], linkEntities: [], linkFacts: [], startsAt: '', status: 'upcoming', ...over } as ChronoEntry);

function create(): BrainStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [BrainStore] });
  return TestBed.inject(BrainStore);
}

describe('BrainStore — tag suggestions', () => {
  const meta = (tagSuggestions: string[]) => ({ tagSuggestions, typeSchemas: {} } as unknown as SpaceMetaResponse);

  // BEHAVIOUR CHANGE, not a test tidy-up. This used to union the space-wide `meta.tagSuggestions`
  // with the tags on loaded records. That list was retired: it was editable in one place, applied to
  // every type and every record form in the space, and was easy to set once and forget — a stored
  // list quietly steering what agents and people tagged with. Suggestions now come from what is
  // actually in use, which maintains itself and needs no editor.
  it('suggests the tags present on loaded records, deduped — and ignores the retired space-wide list', () => {
    const c = create();
    c.spaceMeta.set(meta(['schema-tag', 'shared']));
    c.facts.set([mem('a', { tags: ['shared', 'from-record'] })]);
    expect(c.memoryTagSuggestions()).toEqual(['shared', 'from-record']);
  });

  it('a stored space-wide list contributes nothing, even when no records are loaded', () => {
    // Pins the retirement itself: the value survives in config.json untouched, but it must not come
    // back into the UI through this path.
    const c = create();
    c.spaceMeta.set(meta(['schema-tag']));
    c.facts.set([]);
    expect(c.memoryTagSuggestions()).toEqual([]);
  });

  it('works with no schema suggestions at all', () => {
    const c = create();
    c.spaceMeta.set(null);
    c.entities.set([ent('x', { tags: ['only-record'] })]);
    expect(c.entityTagSuggestions()).toEqual(['only-record']);
  });

  it('each collection draws from its OWN records', () => {
    const c = create();
    c.spaceMeta.set(meta([]));
    c.edges.set([edge('e', { tags: ['edge-tag'] })]);
    c.chrono.set([chrono('c', { tags: ['chrono-tag'] })]);
    expect(c.edgeTagSuggestions()).toEqual(['edge-tag']);
    expect(c.chronoTagSuggestions()).toEqual(['chrono-tag']);
  });
});

describe('BrainStore — type options for the filter bar', () => {
  it('unions schema type names with the types actually present, deduped and sorted', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { fact: { note: {}, decision: {} } } } as unknown as SpaceMetaResponse);
    c.facts.set([mem('a', { type: 'observation' }), mem('b', { type: 'note' })]);
    expect(c.memoryTypeOptions()).toEqual(['decision', 'note', 'observation']);
  });

  it('records with no type contribute nothing', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { fact: { note: {} } } } as unknown as SpaceMetaResponse);
    c.facts.set([mem('a')]);
    expect(c.memoryTypeOptions()).toEqual(['note']);
  });

  it('edge types are not schema-backed — options come only from the loaded list', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { edge: { knows: {} } } } as unknown as SpaceMetaResponse);
    c.edges.set([edge('x', { type: 'runtime-type' })]);
    expect(c.edgeTypeOptions()).toEqual(['runtime-type']);
  });

  it('with no schema and no records the options are empty', () => {
    const c = create();
    c.spaceMeta.set(null);
    expect(c.memoryTypeOptions()).toEqual([]);
  });
});

/**
 * Chrono is the one collection whose type rule is EXCLUSIVE, and the client had no copy of it at all:
 * `getAllowedChronoTypes` (server/src/spaces/schema-validation.ts) returns the declared
 * `typeSchemas.chrono` keys when there are any, and the five built-ins ONLY as a fallback. The forms
 * offered the built-ins unconditionally, so in a space with declared chrono types every option in the
 * dropdown was a value the API answers `type must be one of: …` to.
 */
describe('BrainStore — the chrono type allowlist mirrors the server', () => {
  it('declared chrono types REPLACE the built-ins rather than extending them', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { chrono: { launch: {}, audit: {} } } } as unknown as SpaceMetaResponse);
    expect(c.chronoAllowedTypes()).toEqual(['audit', 'launch']);
    for (const builtIn of c.chronoKinds) {
      expect(c.chronoAllowedTypes()).not.toContain(builtIn);
    }
  });

  it('falls back to the five built-ins when the space declares none', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { fact: { note: {} } } } as unknown as SpaceMetaResponse);
    expect(c.chronoAllowedTypes()).toEqual(['event', 'deadline', 'plan', 'prediction', 'milestone']);
  });

  it('the FILTER also offers a type no longer writable, so old rows stay reachable', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { chrono: { launch: {} } } } as unknown as SpaceMetaResponse);
    c.chrono.set([{ _id: 'c1', type: 'event' } as never]);
    // 'event' is not writable here, but a record already holds it — filtering to it must be possible.
    expect(c.chronoTypeOptions()).toEqual(['event', 'launch']);
    expect(c.chronoAllowedTypes()).toEqual(['launch']);
  });
});

describe('BrainStore — buildPropertiesObject (schema-seeded defaults)', () => {
  const withEntitySchema = (c: BrainStore, propertySchemas: Record<string, unknown>) =>
    c.spaceMeta.set({ typeSchemas: { entity: { Person: { propertySchemas } } } } as unknown as SpaceMetaResponse);

  it('seeds each missing key with a typed default (enum→first, number→0, boolean→false, else "")', () => {
    const c = create();
    withEntitySchema(c, {
      role: { type: 'string', enum: ['admin', 'user'] },
      age: { type: 'number' },
      active: { type: 'boolean' },
      note: { type: 'string' },
    });
    expect(c.buildPropertiesObject('entity', {}, 'Person')).toEqual({
      role: 'admin', age: 0, active: false, note: '',
    });
  });

  it('preserves values already present (does not overwrite existing keys)', () => {
    const c = create();
    withEntitySchema(c, { age: { type: 'number' }, note: { type: 'string' } });
    expect(c.buildPropertiesObject('entity', { age: 42 }, 'Person')).toEqual({ age: 42, note: '' });
  });

  it('returns the existing object unchanged when the type has no schema', () => {
    const c = create();
    c.spaceMeta.set(null);
    const existing = { a: 1 };
    expect(c.buildPropertiesObject('entity', existing)).toBe(existing);
  });

  // ── Ported from the retired `build-properties-schema` simulation test ──────────────────────────
  //
  // That file asserted against a hand-written COPY of this function, so it could only ever prove the
  // copy self-consistent. The cases below were real gaps in this suite, so they moved here and run
  // against the real thing; the rest of the file duplicated what is already above and went with it.

  it('falls back to the FIRST type schema when no type name is given', () => {
    // The form has no type selected yet, and the fallback is what pre-fills it. Object key order is the
    // insertion order the schema was authored in, which is what "first" means here.
    const c = create();
    c.spaceMeta.set({ typeSchemas: { entity: {
      Person: { propertySchemas: { age: { type: 'number' } } },
      Service: { propertySchemas: { tier: { type: 'string' } } },
    } } } as unknown as SpaceMetaResponse);
    expect(c.buildPropertiesObject('entity', {})).toEqual({ age: 0 });
    expect(c.buildPropertiesObject('entity', {}, '')).toEqual({ age: 0 });   // empty name is "no name"
  });

  it('an UNKNOWN type name seeds nothing rather than falling back to the first', () => {
    // The difference matters: falling back here would silently pre-fill a form with another type's
    // fields, which reads as "this type has these properties" and is simply untrue.
    const c = create();
    withEntitySchema(c, { age: { type: 'number' } });
    const existing = { a: 1 };
    expect(c.buildPropertiesObject('entity', existing, 'NoSuchType')).toBe(existing);
  });

  it('reads each knowledge type from its own map — an edge is keyed by LABEL', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: {
      entity: { Person: { propertySchemas: { age: { type: 'number' } } } },
      edge: { depends_on: { propertySchemas: { critical: { type: 'boolean' } } } },
      fact: { decision: { propertySchemas: { rationale: { type: 'string' } } } },
    } } as unknown as SpaceMetaResponse);
    expect(c.buildPropertiesObject('edge', {}, 'depends_on')).toEqual({ critical: false });
    expect(c.buildPropertiesObject('fact', {}, 'decision')).toEqual({ rationale: '' });
  });

  it('a type whose schema declares no properties leaves the existing object alone', () => {
    const c = create();
    withEntitySchema(c, {});
    const existing = { a: 1 };
    expect(c.buildPropertiesObject('entity', existing, 'Person')).toBe(existing);
  });

  it('keeps properties that are not in the schema at all', () => {
    const c = create();
    withEntitySchema(c, { age: { type: 'number' } });
    expect(c.buildPropertiesObject('entity', { custom: 'kept' }, 'Person')).toEqual({ custom: 'kept', age: 0 });
  });
});

describe('BrainStore — chronoSchema', () => {
  it('returns the propertySchemas for a chrono type, undefined when none / no type', () => {
    const c = create();
    c.spaceMeta.set({ typeSchemas: { chrono: { deadline: { propertySchemas: { dueBy: { type: 'string' } } } } } } as unknown as SpaceMetaResponse);
    expect(c.chronoSchema('deadline')).toEqual({ dueBy: { type: 'string' } });
    expect(c.chronoSchema('event')).toBeUndefined();
    expect(c.chronoSchema(undefined)).toBeUndefined();
  });
});

describe('BrainStore — stripEmptyOptionalProps', () => {
  it('drops empty OPTIONAL props but keeps empty REQUIRED ones (and all non-empty)', () => {
    const c = create();
    const schema = { req: { required: true }, opt: {} } as unknown as Record<string, import('../../core/api.types').PropertySchema>;
    expect(c.stripEmptyOptionalProps({ req: '', opt: '', keep: 'x' }, schema)).toEqual({ req: '', keep: 'x' });
  });

  it('returns props untouched when there is no schema', () => {
    const c = create();
    const props = { a: '' };
    expect(c.stripEmptyOptionalProps(props, undefined)).toBe(props);
  });

  // ── Ported from the retired `build-properties-schema` simulation test ──────────────────────────

  it('keeps falsy values that are not the empty string — 0 and false are answers', () => {
    // The check is `v !== ''`, not truthiness, and that distinction is the whole point: a number field
    // left at 0 and a boolean left at false are values the user chose, not blanks to be dropped.
    const c = create();
    const schema = { count: {}, flag: {} } as unknown as Record<string, import('../../core/api.types').PropertySchema>;
    expect(c.stripEmptyOptionalProps({ count: 0, flag: false }, schema)).toEqual({ count: 0, flag: false });
  });

  it('strips an empty property the schema has never heard of', () => {
    // An unknown key has no `required` flag, so it is optional by default and an empty one is noise.
    const c = create();
    const schema = { known: {} } as unknown as Record<string, import('../../core/api.types').PropertySchema>;
    expect(c.stripEmptyOptionalProps({ known: 'v', stray: '' }, schema)).toEqual({ known: 'v' });
  });

  it('an all-empty optional set strips to nothing', () => {
    const c = create();
    const schema = { a: {}, b: {} } as unknown as Record<string, import('../../core/api.types').PropertySchema>;
    expect(c.stripEmptyOptionalProps({ a: '', b: '' }, schema)).toEqual({});
  });
});
