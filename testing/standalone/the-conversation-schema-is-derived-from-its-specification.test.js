/**
 * The generic conversation schema the harness declares IS the specification, not a copy of it.
 *
 * ## What went wrong without this
 *
 * `INGESTION.md` specifies a product-grade knowledge schema for any conversation: nine entity types
 * (`person`, `place`, `organization`, `work`, `object`, `activity`, `condition`, `project`, `animal`) and
 * fourteen edge labels with both endpoints pinned — `works_at` runs person to organization and nothing else.
 * It was written blind to the benchmark's questions, on purpose, so that it describes a corpus of any kind.
 *
 * **Not one ingest rung implemented it.** Every rung declared its own transcript-shaped schema instead — one
 * `memory.utterance` type carrying `session`, `turn`, `speaker`, `statedOn`, `turns` — and the single rung
 * that declared entities at all typed them as `subject` with `namingPattern: ^[a-z]{4,}$`, which admitted
 * `anything`, `around` and `also` as nodes of the graph. So the graph claim had never been tested by
 * anything, and the specification sat in a document being true.
 *
 * ## Why derived rather than written out again
 *
 * A schema hand-copied out of `INGESTION.md` is the second copy of a rule, which is the defect this
 * repository produces most. It would be correct on the day it was typed and would then drift, silently, in
 * the direction of whatever the benchmark rewarded — which is the exact failure the specification's own
 * question-blindness rule exists to prevent.
 *
 * So the module reads the spec. This gate is what stops the reading from going quietly wrong: a parser that
 * finds nothing returns an empty schema, an empty schema validates nothing, and a corpus validated by
 * nothing scores badly and reads as a finding about retrieval.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  conversationEntityTypes, conversationEdgeLabels, conversationTypeSchemas,
} from '../../benchmarks/harness/ingest/_conversation-schema.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spec = readFileSync(join(repoRoot, 'benchmarks', 'INGESTION.md'), 'utf8');

/** The spec's own fenced JSON, read here independently of the module, so the two can disagree. */
function specBlock(heading) {
  const at = spec.indexOf(`## ${heading}`);
  assert.ok(at > -1, `INGESTION.md has no "## ${heading}" section — the gate's own anchor is stale`);
  const open = spec.indexOf('```json', at) + 7;
  const close = spec.indexOf('```', open);
  return JSON.parse(spec.slice(open, close));
}

describe('the vocabulary comes from the specification', () => {
  test('every entity type the spec defines is declared, and no other', () => {
    const fromSpec = specBlock('Entity types').map(e => e.type).filter(t => !t.startsWith('__')).sort();
    assert.deepEqual(Object.keys(conversationEntityTypes()).sort(), fromSpec);
  });

  test('every edge label the spec defines is declared, and no other', () => {
    const fromSpec = specBlock('Edge labels').map(e => e.label).filter(l => !l.startsWith('__')).sort();
    assert.deepEqual(Object.keys(conversationEdgeLabels()).sort(), fromSpec);
  });

  test('a label keeps the endpoints the spec gave it, which is what stops the graph meaning anything else', () => {
    // The single most valuable thing a declared schema does here: `works_at` from a place is refused by the
    // instance rather than quietly making a path read as something nobody wrote.
    const labels = conversationEdgeLabels();
    assert.deepEqual(labels['works_at'].endpoints, { from: ['person'], to: ['organization'] });
    assert.deepEqual(labels['created_by'].endpoints, { from: ['work'], to: ['person'] });
    // A spec entry with alternatives becomes a list, in the spec's own order.
    assert.deepEqual(labels['owns'].endpoints, { from: ['person'], to: ['animal', 'object'] });
  });

  test('a type keeps the properties the spec gave it', () => {
    const person = conversationEntityTypes()['person'];
    for (const key of ['role', 'aliases', 'firstSeenOn', 'lastSeenOn']) {
      assert.ok(person.propertySchemas[key], `person lost the spec's '${key}' property`);
    }
  });

  test('a date in the spec becomes a date to the instance, not a string', () => {
    // `firstSeenOn` is documented as YYYY-MM-DD. Declared as a string it validates nothing useful, and the
    // instance cannot range-query it.
    assert.equal(conversationEntityTypes()['person'].propertySchemas['firstSeenOn'].type, 'date');
    assert.equal(conversationEntityTypes()['project'].propertySchemas['startedOn'].type, 'date');
  });
});

describe('what a rung actually declares', () => {
  test('the composed schema carries entities, edges and a memory type', () => {
    const schema = conversationTypeSchemas();
    assert.ok(schema.entity && Object.keys(schema.entity).length > 0, 'no entity types');
    assert.ok(schema.edge && Object.keys(schema.edge).length > 0, 'no edge labels');
    assert.ok(schema.memory && Object.keys(schema.memory).length > 0, 'no memory type to hold a claim');
  });

  test('the memory type carries provenance, because a claim with no source is not auditable', () => {
    const utterance = conversationTypeSchemas().memory['utterance'];
    assert.ok(utterance.propertySchemas['statedOn'], 'a claim with no date cannot answer a temporal question');
    assert.ok(utterance.propertySchemas['speaker'], 'a claim with no speaker cannot be attributed');
  });

  test('a caller can add its own properties without editing the module', () => {
    // The harness needs a `turn` property that the PRODUCT schema must never carry: it is the scorer's join
    // key. Passing it in keeps the benchmark's bookkeeping out of the shared vocabulary.
    const schema = conversationTypeSchemas({ memoryProperties: { turn: { type: 'string', required: true } } });
    assert.ok(schema.memory['utterance'].propertySchemas['turn']);
    assert.ok(!conversationTypeSchemas().memory['utterance'].propertySchemas['turn'],
      'the extra leaked into the default — the caller mutated the shared object');
  });
});

describe('the floors, because a parser that finds nothing returns a schema that validates nothing', () => {
  test('an empty or unparseable spec throws rather than yielding an empty vocabulary', () => {
    assert.throws(() => conversationEntityTypes({ source: '# nothing here' }), /Entity types/);
    assert.throws(() => conversationEdgeLabels({ source: '# nothing here' }), /Edge labels/);
  });

  test('a label with no endpoints throws rather than being declared unconstrained', () => {
    const broken = '## Edge labels\n\n```json\n[{"label":"vague","properties":{}}]\n```\n';
    assert.throws(() => conversationEdgeLabels({ source: broken }), /vague/);
  });
});
