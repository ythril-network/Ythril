/**
 * The conversation space's schema is a graph, and it is a file Ythril will actually accept.
 *
 * ## What this is guarding
 *
 * `benchmarks/space/schema.json` is the only thing left in `benchmarks/` besides the dataset loader and a
 * plan. Twelve ingest strategies were deleted rather than adapted: they all took a conversation to be a pile
 * of transcript chunks, and measured, that premise caps out — the best of them answered 50.8% of questions
 * at rank 1 and **multi-hop scored 0.0% under every single one**, because those answers need two remarks from
 * sessions weeks apart and no chunk of consecutive turns holds both.
 *
 * So nothing else here can notice a mistake in the schema. No runner exercises it, no strategy declares it,
 * no result contradicts it.
 *
 * ## Two ways it could be wrong, and both are silent
 *
 * **It could be unimportable.** The file is meant to be POSTed to the schema library and shared, so a field
 * the server refuses makes it a document rather than a schema. This gate validates it against the server's
 * OWN zod schema — imported, never restated, because a second copy of a validation grammar is the defect
 * this repository produces most and it would drift the first time the real one gained a field.
 *
 * **It could be a list rather than a graph.** An edge naming a type nothing declares is refused at write
 * time on every attempt, for ever, with the schema itself looking fine. An entity type no edge names can be
 * minted and can never be part of a path.
 *
 * ## What it deliberately does not assert
 *
 * Which types exist. A gate naming `person`, `place` and `organization` is a second copy of the vocabulary
 * that has to be edited whenever the schema grows — a changelog with assertions in it, not a check. Every
 * rule below holds whatever the vocabulary becomes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { LibraryTypeSchemaZ } = await import('../../server/dist/api/schema-library.js');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = JSON.parse(readFileSync(join(repoRoot, 'benchmarks', 'space', 'schema.json'), 'utf8'));

const of = kind => entries.filter(e => e.knowledgeType === kind);
const namesOf = kind => new Set(of(kind).map(e => e.typeName));

describe('the file is importable', () => {
  test('there is something in it', () => {
    // The floor: every loop below passes over an empty array, and an empty schema declares nothing — which
    // under strict mode means the space validates NOTHING, and reads as a clean run.
    assert.ok(Array.isArray(entries) && entries.length > 0, 'schema.json is empty or not an array');
  });

  test('every entry validates against the server\'s own library schema', () => {
    for (const e of entries) {
      const parsed = LibraryTypeSchemaZ.safeParse(e.schema);
      assert.ok(parsed.success, `${e.name} would be refused by the schema library: ${parsed.error?.message}`);
    }
  });

  test('every entry carries the envelope the import needs', () => {
    const kinds = new Set(['entity', 'edge', 'memory', 'chrono']);
    const seen = new Set();
    for (const e of entries) {
      assert.ok(kinds.has(e.knowledgeType), `${e.name} has knowledgeType '${e.knowledgeType}'`);
      // The character rule and the length rule, kept apart. A capped quantifier here would be a second
      // copy of the server's own bound, and a stale one the day it moves.
      assert.match(e.name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `${e.name} is not a legal library name`);
      assert.ok(e.name.length <= 200, `${e.name} is too long for a library name`);
      assert.ok(e.typeName && e.description, `${e.name} is missing typeName or description`);
      assert.ok(!seen.has(e.name), `${e.name} is declared twice`);
      seen.add(e.name);
    }
  });

  test('the whole file is one importable group', () => {
    const groups = new Set(entries.map(e => e.schemaGroup));
    assert.equal(groups.size, 1, `entries are spread across ${groups.size} groups, so importing one misses the rest`);
  });
});

describe('it describes a graph', () => {
  test('every edge pins both ends, because an unpinned one enforces nothing', () => {
    for (const e of of('edge')) {
      assert.ok(e.schema.endpoints?.from?.length, `edge '${e.typeName}' has no 'from'`);
      assert.ok(e.schema.endpoints?.to?.length, `edge '${e.typeName}' has no 'to'`);
    }
  });

  test('every edge points at entity types the file declares', () => {
    const declared = namesOf('entity');
    for (const e of of('edge')) {
      for (const t of [...e.schema.endpoints.from, ...e.schema.endpoints.to]) {
        assert.ok(declared.has(t), `edge '${e.typeName}' names '${t}', which no entity type declares`);
      }
    }
  });

  test('every entity type is named by some edge, or nothing can reach it', () => {
    const reachable = new Set(of('edge').flatMap(e => [...e.schema.endpoints.from, ...e.schema.endpoints.to]));
    for (const t of namesOf('entity')) {
      assert.ok(reachable.has(t), `entity type '${t}' is named by no edge, so it can never be part of a path`);
    }
  });

  test('there is somewhere for a claim to go', () => {
    assert.ok(of('memory').length > 0, 'no memory type — nothing can hold a thing that was said');
  });
});

describe('the rules the owner set for it', () => {
  test('every date is declared as a date, not as a string', () => {
    /*
     * A date stored as a string cannot be compared, only matched, so a question about when has nothing to
     * work with. The name is the tell, and the type is what the instance acts on.
     *
     * The camelCase `On` suffix is matched CASE-SENSITIVELY and on its own. Folded into the
     * case-insensitive alternation as `on$` it also matches `relation`, and this gate failed on a perfectly
     * good `relation: string` the first time it ran.
     */
    const namedLikeADate = key => /date|since|until|born|acquired|started|^year$/i.test(key) || /[a-z]On$/.test(key);
    for (const e of entries) {
      for (const [key, prop] of Object.entries(e.schema.propertySchemas ?? {})) {
        if (!namedLikeADate(key)) continue;
        assert.equal(prop.type, 'date', `${e.typeName}.${key} reads as a date and is declared '${prop.type}'`);
      }
    }
  });

  test('a date lives on an edge or in chrono — never on an entity', () => {
    // Owner, 2026-09-09: "every date that is not in an edge is a chrono". A date is something that happened,
    // and something that happened is a point in time with its own record, linked to what it concerns.
    for (const e of of('entity')) {
      for (const [key, prop] of Object.entries(e.schema.propertySchemas ?? {})) {
        assert.notEqual(prop.type, 'date',
          `entity '${e.typeName}' carries the date '${key}' — a date that does not qualify an edge is a chrono entry`);
      }
    }
    assert.ok(of('chrono').length > 0, 'dates were taken off the entities and there is no chrono type to hold them');
  });

  test('an edge does not narrate', () => {
    // Owner, same day: "an edge or property of an edge that tells a story is a memory or chrono". An edge
    // says THAT two things are related and FOR HOW LONG. How strongly, how severely, how it changed — those
    // are things somebody said, so they belong on a claim.
    const narrative = ['status', 'strength', 'severity', 'frequency', 'sentiment', 'confidence', 'note', 'summary'];
    for (const e of of('edge')) {
      for (const key of Object.keys(e.schema.propertySchemas ?? {})) {
        assert.ok(!narrative.includes(key), `edge '${e.typeName}' carries '${key}', which tells a story`);
      }
    }
  });

  test('no transcript bookkeeping anywhere in the file', () => {
    // These describe the file a conversation arrived in, not the conversation. They are also folded into the
    // embedded text as `key value`, so each one is meaningless tokens inside every vector in the space.
    const bookkeeping = ['turn', 'turns', 'session', 'sessions', 'conversationId', 'lineNumber', 'offset'];
    for (const e of entries) {
      for (const key of Object.keys(e.schema.propertySchemas ?? {})) {
        assert.ok(!bookkeeping.includes(key), `'${e.name}' carries '${key}', which belongs to the source file`);
      }
    }
  });
});
