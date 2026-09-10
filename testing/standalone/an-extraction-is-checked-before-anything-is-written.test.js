/**
 * A bad extraction is refused before the first record is written, and every problem is named at once.
 *
 * ## The failure this exists for
 *
 * The writer makes hundreds of requests per conversation. An undeclared type, or an edge drawn between the
 * wrong kinds of thing, is a 400 from the instance — arriving on request 340, with 339 records already
 * stored. What is left is a space holding most of a conversation: interpretable, wrong, and saying nothing
 * about it. A benchmark run against it reports a number.
 *
 * The quieter half is keys. An extraction refers to its own records by a local `key`, because it is written
 * before anything has an id. A claim naming a key nothing defines produces a link that is simply absent — the
 * instance stores a perfectly valid record with one fewer link and reports success. Nothing anywhere fails.
 *
 * ## Why the validator must report all of them
 *
 * Each round trip through the validator is a round trip through a model. A validator that stops at the first
 * problem turns one bad extraction into a dozen re-runs, so this asserts the count as well as the content.
 *
 * ## The fixtures are literal on purpose
 *
 * A fixture derived from the schema would assert that the code equals itself. These name types and labels the
 * real schema declares, and the gate that keeps THOSE honest is the schema's own — if `works_at` stops being
 * person-to-organization, that gate fails, not this one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';

/** A minimal schema in the shape `space/schema.json` holds, so the validator is exercised, not mocked. */
const SCHEMA = [
  { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: {} } },
  { knowledgeType: 'entity', typeName: 'organization', schema: { propertySchemas: {} } },
  { knowledgeType: 'entity', typeName: 'place', schema: { propertySchemas: {} } },
  { knowledgeType: 'edge', typeName: 'works_at', schema: { endpoints: { from: ['person'], to: ['organization'] } } },
  { knowledgeType: 'chrono', typeName: 'event', schema: { propertySchemas: {} } },
  { knowledgeType: 'memory', typeName: 'utterance', schema: { propertySchemas: {} } },
];

/** A file with nothing wrong with it. Each test breaks exactly one thing. */
const good = () => ({
  conversationId: 'conv-x',
  sessions: [{ date: '2023-05-08', text: 'Ada: hello' }],
  entities: [
    { key: 'ada', type: 'person', name: 'Ada' },
    { key: 'acme', type: 'organization', name: 'Acme' },
  ],
  edges: [{ label: 'works_at', from: 'ada', to: 'acme', properties: { since: '2021-03-01' } }],
  chrono: [{ key: 'joined', type: 'event', title: 'Ada joined Acme', date: '2021-03-01', entities: ['ada'] }],
  claims: [{
    text: 'Ada: I started at Acme in March.', speaker: 'Ada', statedOn: '2023-05-08',
    entities: ['ada', 'acme'], chrono: ['joined'], sourceTurns: ['D1:1'],
  }],
});

const problemsFor = mutate => {
  const e = good();
  mutate(e);
  return validateExtraction(e, SCHEMA);
};

describe('a good file passes', () => {
  test('nothing is reported', () => {
    assert.deepEqual(validateExtraction(good(), SCHEMA), []);
  });
});

describe('what the instance would refuse, found first', () => {
  test('an entity type the schema does not declare', () => {
    const p = problemsFor(e => { e.entities[0].type = 'wizard'; });
    assert.equal(p.length, 1);
    assert.match(p[0], /wizard.*does not declare/);
  });

  test('an edge label the schema does not declare', () => {
    const p = problemsFor(e => { e.edges[0].label = 'vibes_with'; });
    assert.match(p.join(' '), /vibes_with.*does not declare/);
  });

  test('an edge whose end is the wrong kind of thing', () => {
    // `works_at` runs person to organization. An organization at the `from` end is a graph that means
    // something nobody wrote, and the instance refuses it — on request 340.
    const p = problemsFor(e => { e.edges[0].from = 'acme'; });
    assert.equal(p.length, 1);
    assert.match(p[0], /from is a 'organization' and the label allows person/);
  });

  test('a date that is not YYYY-MM-DD, wherever it appears', () => {
    assert.match(problemsFor(e => { e.chrono[0].date = 'last year'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.claims[0].statedOn = '2023'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.edges[0].properties.since = 'March'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.sessions[0].date = '08-05-2023'; }).join(' '), /not YYYY-MM-DD/);
  });
});

describe('what the instance would NOT catch, which is the point', () => {
  test('a claim linking to an entity key nothing defines', () => {
    // The instance sees a valid claim with one fewer link and stores it. Nothing fails, and the graph has a
    // hole in it that reads later as a retrieval result.
    const p = problemsFor(e => { e.claims[0].entities = ['ada', 'ghost']; });
    assert.equal(p.length, 1);
    assert.match(p[0], /entity key 'ghost', which nothing defines/);
  });

  test('a claim linking to a chrono key nothing defines', () => {
    assert.match(problemsFor(e => { e.claims[0].chrono = ['nope']; }).join(' '), /chrono key 'nope'/);
  });

  test('an edge end naming no entity at all', () => {
    assert.match(problemsFor(e => { e.edges[0].to = 'nowhere'; }).join(' '), /to is 'nowhere', which no entity defines/);
  });

  test('a chrono entry linking to an entity key nothing defines', () => {
    assert.match(problemsFor(e => { e.chrono[0].entities = ['ghost']; }).join(' '), /entity key 'ghost'/);
  });

  test('two records claiming the same key', () => {
    assert.match(problemsFor(e => { e.entities[1].key = 'ada'; }).join(' '), /redefines the key 'ada'/);
  });
});

describe('what a claim must carry', () => {
  test('a speaker, because a claim nobody can attribute is not auditable', () => {
    assert.match(problemsFor(e => { delete e.claims[0].speaker; }).join(' '), /no speaker/);
  });

  test('source turns, or nothing can trace it back to the transcript', () => {
    assert.match(problemsFor(e => { e.claims[0].sourceTurns = []; }).join(' '), /names no sourceTurns/);
  });

  test('text', () => {
    assert.match(problemsFor(e => { delete e.claims[0].text; }).join(' '), /has no text/);
  });
});

describe('the claim layer is complete', () => {
  test('a turn in no claim is reported, when the sessions say which turns they had', () => {
    // Measured: keeping only the turns that seemed to say something covered 34.6% of a conversation and
    // scored worse on every measure than storing the raw turns. The graph looked fine — it was just
    // missing two thirds of what was said.
    const e = good();
    e.sessions[0].turns = ['D1:1', 'D1:2', 'D1:3'];
    const p = validateExtraction(e, SCHEMA);
    assert.equal(p.length, 1);
    assert.match(p[0], /2 of 3 turns are in no claim \(D1:2, D1:3\)/);
  });

  test('and says nothing when every turn is covered', () => {
    const e = good();
    e.sessions[0].turns = ['D1:1'];
    assert.deepEqual(validateExtraction(e, SCHEMA), []);
  });

  test('a file whose sessions carry no turn ids is not refused', () => {
    // The writer has no transcript to compare against, and inventing a failure there would block a caller
    // who is not running a benchmark at all.
    assert.deepEqual(validateExtraction(good(), SCHEMA), []);
  });
});

describe('the floors', () => {
  test('every problem is reported, not the first', () => {
    // A validator that stops at one turns a bad extraction into a dozen round trips through a model.
    const p = problemsFor(e => {
      e.entities[0].type = 'wizard';
      e.edges[0].label = 'vibes_with';
      e.claims[0].statedOn = 'yesterday';
      e.chrono[0].entities = ['ghost'];
    });
    assert.equal(p.length, 4, `expected four problems, got: ${p.join(' | ')}`);
  });

  test('an extraction with no claims is refused rather than written as an empty space', () => {
    assert.match(problemsFor(e => { e.claims = []; }).join(' '), /no claims/);
  });

  test('an empty schema is refused rather than validating everything', () => {
    // With nothing declared, strict mode validates NOTHING — so a file checked against an empty schema
    // passes and the space accepts anything. That reads as a clean run.
    const p = validateExtraction(good(), []);
    assert.equal(p.length, 1);
    assert.match(p[0], /schema loaded with no entity types/);
  });

  test('something that is not an extraction at all', () => {
    assert.deepEqual(validateExtraction(null, SCHEMA), ['the extraction is not an object']);
  });
});
