/**
 * Every record of a space has one computed RDF form, built by one pure module from standard vocabularies (Q-749, design r4 §5.2).
 *
 * ## The defect this prevents
 *
 * A record form built twice drifts; a property value read as an IRI because its string "looks like" a record id turns data into links no
 * author wrote; a list or an object a direct database write left in a property, exported as a guess (or dropped without a word), makes an
 * export lie. The owner's rule (2026-11-18, decision record 23): a property holds ONE plain value, and a stray list or object value is
 * LEFT OUT of the form and NAMED in the result (which record, which property) — never silent, never serialised as a guess, never a failure.
 *
 * `recordTriples(meta, kind, doc, opts)` in `server/src/rdf/record-triples.ts` answers `{ quads, counts, leftOut? }`:
 *
 * - **every kind has its triples**: entity, fact, chrono (any type), edge (the object property plus a reifier), link, file;
 * - **a literal is typed by the schema's declared type** (`string`, `number` as `xsd:decimal`, `boolean`, `date` calendar-checked, its stored
 *   lexical form kept); a value that does not fit its declared type is left out and named, as a list is;
 * - **a property value is a literal and never an IRI or a node**, whatever the string looks like;
 * - **a list or an object value** gives no triple and appears in `counts.skippedValues` as `{ recordId, kind, key }`, the rest of the record
 *   unchanged; `null` states nothing and is not counted; `rdf:JSON` appears nowhere;
 * - **a personal view's records keep the address of their home space**: the mapper names a record by the meta it is handed;
 * - **the same record gives the same quads on every run** whatever the order of its keys and tags;
 * - **it reads only `RDF_READ_FIELDS`**, so a local-only field (a vector, matched text, a write guard) can never go out.
 *
 * Run: node --test testing/standalone/every-record-kind-has-its-triples.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const fn = (name) => {
  assert.equal(typeof mod[name], 'function', `${name} is not exported by server/src/rdf/record-triples.ts: the record has no RDF form`);
  return mod[name];
};

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', xsd: 'http://www.w3.org/2001/XMLSchema#',
  schema: 'https://schema.org/', time: 'http://www.w3.org/2006/time#', dcterms: 'http://purl.org/dc/terms/', prov: 'http://www.w3.org/ns/prov#',
};
const YT = () => vocab.YTHRIL_NS;

const META = {
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' }, born: { type: 'date' }, active: { type: 'boolean' }, email: { type: 'string', iri: 'https://schema.org/email' } } } },
    fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
    chrono: { event: { propertySchemas: { room: { type: 'string' } } }, deadline: {} },
    edge: { knows: { propertySchemas: { since: { type: 'date' }, strength: { type: 'number' } } } },
  },
};
const OTHER_META = { ...META, rdf: { enabled: true, base: 'https://other.example.net/ld/space-9/', vocab: 'https://other.example.net/ld/space-9/vocab/', baseEpoch: 0 } };
const AUTHOR = { instanceId: 'inst-1', instanceLabel: 'Home' };
const SHARED = { author: AUTHOR, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00.5+01:00' };

const iri = (value) => ({ kind: 'iri', value });
const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
const xsd = (n) => `${NS.xsd}${n}`;
const OPTS = { edgeDetails: 'rdf12' };
const run = (kind, doc, meta = META, opts = OPTS) => fn('recordTriples')(meta, kind, doc, opts);

const keyOf = (q) => JSON.stringify([q.subject, q.predicate, q.object, q.graph ?? null]);
/** Objects of `subject predicate` in `quads`, as terms. */
const objects = (quads, subject, predicate) => quads.filter((q) => q.subject.kind === 'iri' && q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object);
const only = (quads, subject, predicate) => {
  const found = objects(quads, subject, predicate);
  assert.equal(found.length, 1, `${subject} ${predicate}: expected one object, found ${JSON.stringify(found)}`);
  return found[0];
};
const has = (quads, subject, predicate, object) => quads.some((q) => keyOf(q) === keyOf({ subject: iri(subject), predicate: iri(predicate), object }));

describe('the entity form', () => {
  const e = {
    _id: 'e1', name: 'Ada Lovelace', type: 'person', tags: ['math', 'analytic'], description: 'Wrote the first program.', superseded: true,
    schemaFingerprint: 'abc123', ...SHARED,
    properties: { age: 36, nick: 'ada', born: '1815-12-10', active: true, email: 'ada@example.org', ref: 'e2', link: 'https://example.org/a' },
  };
  const S = `${BASE}entity/e1`;
  const { quads, counts } = run('entity', e);

  it('is typed ythril:Entity and by the space term of its type; its name is the label', () => {
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${YT()}Entity`)));
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${VOCAB}entity/person`)));
    assert.deepEqual(only(quads, S, `${NS.rdfs}label`), lit('Ada Lovelace'));
  });
  it('the shared triples: created, modified (typed by their stored form), keywords, description, superseded, the schema version it conforms to', () => {
    assert.deepEqual(only(quads, S, `${NS.dcterms}created`), lit('2026-01-01T10:00:00Z', xsd('dateTimeStamp')));
    assert.deepEqual(only(quads, S, `${NS.dcterms}modified`), lit('2026-01-02T10:00:00.5+01:00', xsd('dateTimeStamp')));
    assert.deepEqual(objects(quads, S, `${NS.schema}keywords`).map((o) => o.value).sort(), ['analytic', 'math']);
    assert.deepEqual(only(quads, S, `${NS.schema}description`), lit('Wrote the first program.'), 'a plain literal, no language tag');
    assert.deepEqual(only(quads, S, `${YT()}superseded`), lit('true', xsd('boolean')));
    assert.deepEqual(only(quads, S, `${NS.dcterms}conformsTo`), iri(`${BASE}schema/abc123`));
  });
  it('the author is an agent of the space, named once with its label', () => {
    const agent = `${BASE}agent/inst-1`;
    assert.deepEqual(only(quads, S, `${NS.prov}wasAttributedTo`), iri(agent));
    assert.ok(has(quads, agent, `${NS.rdf}type`, iri(`${NS.prov}Agent`)));
    assert.deepEqual(only(quads, agent, `${NS.rdfs}label`), lit('Home'));
  });
  it('every property is ONE literal typed by its declared type, on the term the schema names', () => {
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/age`), lit('36', xsd('decimal')));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/nick`), lit('ada'));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/born`), lit('1815-12-10', xsd('date')));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/active`), lit('true', xsd('boolean')));
    assert.deepEqual(only(quads, S, `${NS.schema}email`), lit('ada@example.org'), 'an explicit iri names the property');
  });
  it('a property value is never an IRI or a node, whatever the string looks like: a record id and a URL stay strings', () => {
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/ref`), lit('e2'));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/link`), lit('https://example.org/a'));
    for (const q of quads) {
      if (q.predicate.value.startsWith(`${VOCAB}entity/person/`)) assert.equal(q.object.kind, 'literal', `${q.predicate.value} holds a literal`);
    }
  });
  it('counts nothing left out', () => {
    assert.deepEqual(counts.skippedValues, []);
    assert.equal(counts.untypedTemporals, 0);
  });
  it('an untyped entity is ythril:Untyped, its properties under the empty type segment', () => {
    const { quads: q } = run('entity', { _id: 'e2', name: 'Anon', tags: [], properties: { colour: 'red' }, ...SHARED });
    const s = `${BASE}entity/e2`;
    assert.ok(has(q, s, `${NS.rdf}type`, iri(`${YT()}Entity`)));
    assert.ok(has(q, s, `${NS.rdf}type`, iri(`${YT()}Untyped`)));
    assert.deepEqual(only(q, s, `${VOCAB}entity/%00/colour`), lit('red'));
  });
  it('an id with a space, a slash and a ">" is encoded in the subject', () => {
    const { quads: q } = run('entity', { _id: 'a b/c>d', name: 'x', type: 'person', tags: [], properties: {}, ...SHARED });
    assert.ok(has(q, `${BASE}entity/a%20b%2Fc%3Ed`, `${NS.rdfs}label`, lit('x')));
  });
});

describe('the fact form', () => {
  it('is ythril:Fact, the space term of its type when it has one, its text as schema:text', () => {
    const { quads } = run('fact', { _id: 'f1', fact: 'Ada knew Babbage.', type: 'note', tags: ['t'], properties: { weight: 2.5, mood: 'dry' }, ...SHARED });
    const S = `${BASE}fact/f1`;
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${YT()}Fact`)));
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${VOCAB}fact/note`)));
    assert.deepEqual(only(quads, S, `${NS.schema}text`), lit('Ada knew Babbage.'));
    assert.deepEqual(only(quads, S, `${VOCAB}fact/note/weight`), lit('2.5', xsd('decimal')));
    assert.deepEqual(only(quads, S, `${VOCAB}fact/note/mood`), lit('dry'));
  });
  it('an untyped fact is ythril:Fact alone (there is no Untyped class for facts)', () => {
    const { quads } = run('fact', { _id: 'f2', fact: 'x', tags: [], ...SHARED });
    const types = objects(quads, `${BASE}fact/f2`, `${NS.rdf}type`).map((o) => o.value);
    assert.deepEqual(types, [`${YT()}Fact`]);
  });
});

describe('the chrono form', () => {
  const S = `${BASE}chrono/c1`;
  it('an event with an end: an interval of two instants, schema dates, the event class and status, the label, status, confidence, recurrence', () => {
    const { quads } = run('chrono', {
      _id: 'c1', title: 'Launch', type: 'event', startsAt: '2026-03-01T09:00:00Z', endsAt: '2026-03-01T17:30:00', status: 'upcoming', confidence: 0.75, tags: [],
      recurrence: { freq: 'weekly', interval: 2, until: '2026-12-31' }, properties: { room: 'A1' }, ...SHARED,
    });
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${VOCAB}chrono/event`)));
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${NS.schema}Event`)));
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${NS.time}Interval`)));
    assert.deepEqual(only(quads, S, `${NS.schema}eventStatus`), iri(`${NS.schema}EventScheduled`));
    assert.deepEqual(only(quads, S, `${NS.rdfs}label`), lit('Launch'));
    assert.deepEqual(only(quads, S, `${YT()}status`), lit('upcoming'));
    assert.deepEqual(only(quads, S, `${YT()}confidence`), lit('0.75', xsd('decimal')));
    assert.deepEqual(only(quads, S, `${NS.schema}startDate`), lit('2026-03-01T09:00:00Z', xsd('dateTimeStamp')));
    assert.deepEqual(only(quads, S, `${NS.schema}endDate`), lit('2026-03-01T17:30:00', xsd('dateTime')), 'no zone: xsd:dateTime');
    const begin = only(quads, S, `${NS.time}hasBeginning`);
    const end = only(quads, S, `${NS.time}hasEnd`);
    assert.equal(begin.kind, 'iri');
    assert.equal(end.kind, 'iri');
    assert.notEqual(begin.value, end.value);
    assert.ok(has(quads, begin.value, `${NS.rdf}type`, iri(`${NS.time}Instant`)));
    assert.deepEqual(only(quads, begin.value, `${NS.time}inXSDDateTimeStamp`), lit('2026-03-01T09:00:00Z', xsd('dateTimeStamp')));
    assert.deepEqual(only(quads, end.value, `${NS.time}inXSDDateTime`), lit('2026-03-01T17:30:00', xsd('dateTime')));
    assert.deepEqual(only(quads, S, `${YT()}recurrenceFreq`), lit('weekly'));
    assert.deepEqual(only(quads, S, `${YT()}recurrenceInterval`), lit('2', xsd('integer')));
    assert.deepEqual(only(quads, S, `${YT()}recurrenceUntil`), lit('2026-12-31', xsd('date')));
    assert.deepEqual(only(quads, S, `${VOCAB}chrono/event/room`), lit('A1'));
  });
  it('without an end the record is itself the instant; a date-only start is typed xsd:date', () => {
    const { quads } = run('chrono', { _id: 'c2', title: 'Due', type: 'deadline', startsAt: '2026-04-05', status: 'active', tags: [], ...SHARED });
    const s = `${BASE}chrono/c2`;
    assert.ok(has(quads, s, `${NS.rdf}type`, iri(`${NS.time}Instant`)));
    assert.deepEqual(only(quads, s, `${NS.time}inXSDDate`), lit('2026-04-05', xsd('date')));
    assert.equal(objects(quads, s, `${NS.schema}eventStatus`).length, 0, 'only an event has an event status');
    assert.ok(!has(quads, s, `${NS.rdf}type`, iri(`${NS.schema}Event`)));
  });
  it('a cancelled event is schema:EventCancelled; a type the space does not declare is still named by the vocab rule', () => {
    const { quads } = run('chrono', { _id: 'c3', title: 'x', type: 'event', startsAt: '2026-04-05T10:00:00Z', status: 'cancelled', tags: [], ...SHARED });
    assert.deepEqual(only(quads, `${BASE}chrono/c3`, `${NS.schema}eventStatus`), iri(`${NS.schema}EventCancelled`));
    const other = run('chrono', { _id: 'c4', title: 'x', type: 'milestone', startsAt: '2026-04-05T10:00:00Z', status: 'completed', tags: [], ...SHARED });
    assert.ok(has(other.quads, `${BASE}chrono/c4`, `${NS.rdf}type`, iri(`${VOCAB}chrono/milestone`)));
  });
  it('a time that is no calendar date gets no time node, stays a plain string and is counted', () => {
    const { quads, counts } = run('chrono', { _id: 'c5', title: 'x', type: 'event', startsAt: '2026-02-30T10:00:00Z', status: 'upcoming', tags: [], ...SHARED });
    const s = `${BASE}chrono/c5`;
    assert.deepEqual(only(quads, s, `${NS.schema}startDate`), lit('2026-02-30T10:00:00Z'));
    assert.ok(!quads.some((q) => q.predicate.value.startsWith(NS.time)), 'no time: triple for an unparseable time');
    assert.ok(counts.untypedTemporals >= 1);
  });
  it('a redacted entry says so', () => {
    const { quads } = run('chrono', { _id: 'c6', title: 'x', type: 'event', startsAt: '2026-04-05T10:00:00Z', status: 'completed', tags: [], contentRedacted: true, ...SHARED });
    assert.deepEqual(only(quads, `${BASE}chrono/c6`, `${YT()}contentRedacted`), lit('true', xsd('boolean')));
  });
});

describe('the edge, link and file forms', () => {
  it('an edge is a triple between the two records addresses, and its own details sit on a reifier', () => {
    const { quads } = run('edge', {
      _id: 'ed1', from: 'e1', to: 'e2', label: 'knows', type: 'friendship', weight: 0.5, tags: ['t'], description: 'met at school',
      properties: { since: '2001-09-01', strength: 3 }, ...SHARED,
    });
    const from = `${BASE}entity/e1`, to = `${BASE}entity/e2`, r = `${BASE}edge/ed1`;
    assert.ok(has(quads, from, `${VOCAB}edge/knows`, iri(to)), 'the object property between the two addresses');
    const reifies = only(quads, r, `${NS.rdf}reifies`);
    assert.deepEqual(reifies, { kind: 'triple', subject: iri(from), predicate: iri(`${VOCAB}edge/knows`), object: iri(to) });
    assert.deepEqual(only(quads, r, `${YT()}weight`), lit('0.5', xsd('decimal')));
    assert.deepEqual(only(quads, r, `${YT()}edgeType`), lit('friendship'));
    assert.deepEqual(only(quads, r, `${VOCAB}edge/knows/since`), lit('2001-09-01', xsd('date')));
    assert.deepEqual(only(quads, r, `${VOCAB}edge/knows/strength`), lit('3', xsd('decimal')));
    assert.deepEqual(only(quads, r, `${NS.schema}description`), lit('met at school'));
    assert.deepEqual(only(quads, r, `${NS.dcterms}created`), lit('2026-01-01T10:00:00Z', xsd('dateTimeStamp')));
  });
  it('the same edge in classic reification: a statement resource with subject, predicate and object', () => {
    const { quads } = run('edge', { _id: 'ed1', from: 'e1', to: 'e2', label: 'knows', tags: [], ...SHARED }, META, { edgeDetails: 'reification' });
    const r = `${BASE}edge/ed1`;
    assert.ok(has(quads, r, `${NS.rdf}type`, iri(`${NS.rdf}Statement`)));
    assert.deepEqual(only(quads, r, `${NS.rdf}subject`), iri(`${BASE}entity/e1`));
    assert.deepEqual(only(quads, r, `${NS.rdf}predicate`), iri(`${VOCAB}edge/knows`));
    assert.deepEqual(only(quads, r, `${NS.rdf}object`), iri(`${BASE}entity/e2`));
    assert.equal(objects(quads, r, `${NS.rdf}reifies`).length, 0);
    assert.ok(!quads.some((q) => q.object.kind === 'triple'), 'no triple term in classic reification');
  });
  it('an edge end of another kind is named by its kind; an end outside the exported set is still named by its address', () => {
    const { quads } = run('edge', { _id: 'ed2', from: 'f1', fromKind: 'fact', to: 'docs/a b.pdf', toKind: 'file', label: 'cites', tags: [], ...SHARED });
    assert.ok(has(quads, `${BASE}fact/f1`, `${VOCAB}edge/cites`, iri(`${BASE}file/docs/a%20b.pdf`)));
  });
  it('a link is dcterms:references between the two records addresses', () => {
    const { quads } = run('link', { _id: 'l1', from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity', author: AUTHOR, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z' });
    assert.ok(has(quads, `${BASE}fact/f1`, `${NS.dcterms}references`, iri(`${BASE}entity/e1`)));
  });
  it('a file is a schema:MediaObject with its path, size, hash, description, keywords, properties and times', () => {
    const { quads } = run('file', {
      _id: 'docs/a b.pdf', path: 'docs/a b.pdf', description: 'A scan.', tags: ['scan'], sizeBytes: 1024, sha256: 'ab'.repeat(32),
      properties: { pages: 4, owner: 'ada' }, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00Z',
    });
    const S = `${BASE}file/docs/a%20b.pdf`;
    assert.ok(has(quads, S, `${NS.rdf}type`, iri(`${NS.schema}MediaObject`)));
    assert.deepEqual(only(quads, S, `${YT()}path`), lit('docs/a b.pdf'));
    assert.deepEqual(only(quads, S, `${YT()}sizeBytes`), lit('1024', xsd('integer')));
    assert.deepEqual(only(quads, S, `${NS.schema}sha256`), lit('ab'.repeat(32)));
    assert.deepEqual(only(quads, S, `${NS.schema}description`), lit('A scan.'));
    assert.deepEqual(objects(quads, S, `${NS.schema}keywords`), [lit('scan')]);
    assert.deepEqual(only(quads, S, `${VOCAB}file/pages`), lit('4', xsd('decimal')));
    assert.deepEqual(only(quads, S, `${VOCAB}file/owner`), lit('ada'));
    assert.deepEqual(only(quads, S, `${NS.dcterms}created`), lit('2026-01-01T10:00:00Z', xsd('dateTimeStamp')));
  });
});

describe('what the form leaves out of a record, and names', () => {
  const entity = (properties) => ({ _id: 'e9', name: 'N', type: 'person', tags: ['t'], properties, ...SHARED });
  const baseline = run('entity', entity({ nick: 'n' }));

  it('a list value and an object value give no triple and are named as (record, property); the rest of the record is unchanged', () => {
    const { quads, counts } = run('entity', entity({ nick: 'n', stray: ['a', 'b'], nested: { x: 1 } }));
    assert.deepEqual(quads.map(keyOf), baseline.quads.map(keyOf), 'every other triple is as without the two values');
    assert.deepEqual(
      counts.skippedValues.map(({ recordId, kind, key }) => ({ recordId, kind, key })).sort((a, b) => a.key.localeCompare(b.key)),
      [{ recordId: 'e9', kind: 'entity', key: 'nested' }, { recordId: 'e9', kind: 'entity', key: 'stray' }],
    );
    for (const s of counts.skippedValues) assert.equal(typeof s.reason, 'string', 'each says why it was left out');
    assert.ok(!quads.some((q) => q.predicate.value.endsWith('/stray') || q.predicate.value.endsWith('/nested')), 'no triple for either');
  });
  it('rdf:JSON appears nowhere, not even for a list', () => {
    const { quads } = run('entity', entity({ stray: [1, 2], nested: { a: [1] } }));
    assert.ok(!quads.some((q) => q.object.kind === 'literal' && /JSON$/.test(q.object.datatype ?? '')), 'no rdf:JSON literal');
  });
  it('a list on an edge, a fact, a chrono entry and a file is left out and named with its own kind', () => {
    const cases = [
      ['edge', { _id: 'x1', from: 'a', to: 'b', label: 'knows', tags: [], properties: { l: [1] }, ...SHARED }],
      ['fact', { _id: 'x2', fact: 't', tags: [], properties: { l: [1] }, ...SHARED }],
      ['chrono', { _id: 'x3', title: 't', type: 'event', startsAt: '2026-01-01T00:00:00Z', status: 'upcoming', tags: [], properties: { l: [1] }, ...SHARED }],
      ['file', { _id: 'x4', path: 'x4', tags: [], sizeBytes: 1, properties: { l: [1] }, createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt }],
    ];
    for (const [kind, doc] of cases) {
      const { counts } = run(kind, doc);
      assert.deepEqual(counts.skippedValues.map(({ recordId, kind: k, key }) => [recordId, k, key]), [[doc._id, kind, 'l']], kind);
    }
  });
  it('null states nothing: no triple, and it is not counted', () => {
    const { quads, counts } = run('entity', entity({ nick: 'n', gone: null }));
    assert.deepEqual(quads.map(keyOf), baseline.quads.map(keyOf));
    assert.deepEqual(counts.skippedValues, []);
  });
  it('a value that does not fit its declared type is left out and named like a list', () => {
    const { quads, counts } = run('entity', entity({ age: 'thirty', active: 'yes', nick: 7, born: 20150101 }));
    for (const p of ['age', 'active', 'nick', 'born']) assert.ok(!quads.some((q) => q.predicate.value === `${VOCAB}entity/person/${p}`), `${p}: no triple`);
    assert.deepEqual(counts.skippedValues.map((s) => s.key).sort(), ['active', 'age', 'born', 'nick']);
  });
  it('a number that is no decimal (NaN, Infinity) is left out and named, never written as a guess', () => {
    const { quads, counts } = run('entity', entity({ age: Number.NaN, other: Number.POSITIVE_INFINITY }));
    assert.ok(!quads.some((q) => q.predicate.value.endsWith('/age') || q.predicate.value.endsWith('/other')));
    assert.deepEqual(counts.skippedValues.map((s) => s.key).sort(), ['age', 'other']);
  });
  it('a date-typed string that is no calendar date stays a plain string and is counted as untyped', () => {
    const { quads, counts } = run('entity', entity({ born: 'last spring' }));
    assert.deepEqual(only(quads, `${BASE}entity/e9`, `${VOCAB}entity/person/born`), lit('last spring'));
    assert.equal(counts.untypedTemporals, 1);
  });
  it('a property of no declared type is typed by what it is: string, decimal or boolean', () => {
    const { quads } = run('entity', entity({ s: 'x', n: -12.5, b: false }));
    const S = `${BASE}entity/e9`;
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/s`), lit('x'));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/n`), lit('-12.5', xsd('decimal')));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/b`), lit('false', xsd('boolean')));
  });
  it('a record the form cannot address (an edge with no ends) gives no triples and says so; it never throws', () => {
    const r = run('edge', { _id: 'bad', from: 7, to: null, label: 'knows', tags: [], ...SHARED });
    assert.deepEqual(r.quads, []);
    assert.equal(typeof r.leftOut, 'string');
  });
  it('a fork row and a file that is no live file are left out whole', () => {
    assert.deepEqual(run('entity', { ...entity({}), forkOf: 'e1' }).quads, []);
    assert.equal(run('entity', { ...entity({}), forkOf: 'e1' }).leftOut, 'fork');
    assert.deepEqual(run('file', { _id: 'g', path: 'g', tags: [], sizeBytes: 1, deletedAt: '2026-01-01T00:00:00Z', createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt }).quads, []);
    assert.deepEqual(run('file', { _id: 'g#chunk1', path: 'g', parentFileId: 'g', tags: [], sizeBytes: 1, createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt }).quads, []);
  });
  it('it never throws on a stored value of the wrong shape', () => {
    const odd = { _id: 'o1', name: 5, type: 7, tags: 'x', description: {}, properties: [1, 2], author: 'me', createdAt: 5, updatedAt: null, superseded: 'yes', schemaFingerprint: 9 };
    for (const kind of ['entity', 'fact', 'chrono', 'edge', 'link', 'file']) {
      assert.doesNotThrow(() => run(kind, odd), kind);
      assert.doesNotThrow(() => run(kind, {}), `${kind} of nothing`);
    }
  });
  it('a property named like an object member (constructor, __proto__, toString) is an ordinary property', () => {
    const properties = JSON.parse('{"constructor":"c","__proto__":"p","toString":"t"}');
    const { quads } = run('entity', entity(properties));
    const S = `${BASE}entity/e9`;
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/constructor`), lit('c'));
    assert.deepEqual(only(quads, S, `${VOCAB}entity/person/toString`), lit('t'));
  });
});

describe('the SkippedLog: the count, the first named, the rest counted', () => {
  it('names the first SKIPPED_VALUES_NAMED_MAX and counts the rest', () => {
    const max = mod.SKIPPED_VALUES_NAMED_MAX;
    assert.equal(typeof max, 'number', 'SKIPPED_VALUES_NAMED_MAX is exported');
    const log = fn('createSkippedLog')();
    const values = Array.from({ length: max + 7 }, (_, i) => ({ recordId: `r${i}`, kind: 'entity', key: 'k', reason: 'not-a-plain-value' }));
    for (let i = 0; i < values.length; i += 10) log.add(values.slice(i, i + 10));
    const sum = log.summary();
    assert.equal(sum.count, max + 7);
    assert.equal(sum.named.length, max);
    assert.equal(sum.unnamed, 7);
    assert.deepEqual(sum.named[0], values[0]);
    assert.deepEqual(sum.named[max - 1], values[max - 1]);
  });
});

describe('a personal view keeps the address of its home space', () => {
  it('one record under two spaces metas is named under each space base, and under no other', () => {
    const doc = { _id: 'e1', name: 'Ada', type: 'person', tags: [], properties: { nick: 'a' }, ...SHARED };
    const a = run('entity', doc, META).quads;
    const b = run('entity', doc, OTHER_META).quads;
    assert.ok(a.some((q) => q.subject.value === `${BASE}entity/e1`));
    assert.ok(b.some((q) => q.subject.value === 'https://other.example.net/ld/space-9/entity/e1'));
    assert.ok(!b.some((q) => q.subject.value.startsWith(BASE)), 'no address of the other space');
    assert.ok(!a.some((q) => q.subject.value.startsWith('https://other.example.net/')));
  });
  it('RDF off for the space: the form refuses with rdf_not_enabled, naming nothing', () => {
    assert.throws(() => run('entity', { _id: 'e1', name: 'x', type: 'person', tags: [] }, { typeSchemas: META.typeSchemas }), (err) => err?.code === 'rdf_not_enabled');
  });
});

describe('the same record gives the same quads on every run', () => {
  it('the order of properties and tags does not change the form; two runs agree', () => {
    const a = { _id: 'e1', name: 'Ada', type: 'person', tags: ['b', 'a', 'c'], properties: { z: 1, a: 'x', m: true }, ...SHARED };
    const b = { _id: 'e1', name: 'Ada', type: 'person', tags: ['c', 'a', 'b'], properties: { m: true, a: 'x', z: 1 }, ...SHARED };
    assert.deepEqual(run('entity', a).quads, run('entity', b).quads);
    assert.deepEqual(run('entity', a).quads, run('entity', a).quads);
  });
  it('an agent is stated once per (agent, label) when the caller shares its seen-set, and in every record when it does not', () => {
    const doc = (id) => ({ _id: id, name: 'x', type: 'person', tags: [], ...SHARED });
    const seen = new Set();
    const agentTriples = (r) => r.quads.filter((q) => q.subject.value === `${BASE}agent/inst-1`).length;
    assert.ok(agentTriples(run('entity', doc('a'), META, { ...OPTS, agentsSeen: seen })) > 0);
    assert.equal(agentTriples(run('entity', doc('b'), META, { ...OPTS, agentsSeen: seen })), 0, 'already stated');
    assert.ok(agentTriples(run('entity', { ...doc('c'), author: { ...AUTHOR, instanceLabel: 'Renamed' } }, META, { ...OPTS, agentsSeen: seen })) > 0, 'a new label is stated');
    assert.ok(agentTriples(run('entity', doc('d'))) > 0, 'without a shared set, the record states its agent');
  });
});

describe('the form reads only RDF_READ_FIELDS', () => {
  const readFields = () => {
    assert.equal(typeof mod.RDF_READ_FIELDS, 'object', 'RDF_READ_FIELDS is exported by server/src/rdf/record-triples.ts');
    return mod.RDF_READ_FIELDS;
  };
  const LOCAL = { embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 'MATCHED', stampSkew: { property: 'p', stamp: 's', skewMs: 1, thresholdMs: 2 }, suppressEmbeddings: true, _expireAt: new Date(0), _functionalGuard: 'GUARD', syncBase: { p: 'h' }, seq: 7, spaceId: 'sp', _contentExpireAt: new Date(0) };
  const DOCS = {
    entity: { _id: 'e1', name: 'N', type: 'person', tags: ['t'], properties: { nick: 'n' }, ...SHARED, ...LOCAL },
    fact: { _id: 'f1', fact: 'F', type: 'note', tags: ['t'], properties: { weight: 1 }, ...SHARED, ...LOCAL },
    chrono: { _id: 'c1', title: 'T', type: 'event', startsAt: '2026-01-01T00:00:00Z', status: 'upcoming', tags: [], ...SHARED, ...LOCAL },
    edge: { _id: 'ed1', from: 'e1', to: 'e2', label: 'knows', tags: [], ...SHARED, ...LOCAL },
    link: { _id: 'l1', from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity', ...SHARED, ...LOCAL },
    file: { _id: 'p', path: 'p', tags: [], sizeBytes: 1, createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt, ...LOCAL },
  };
  for (const [kind, doc] of Object.entries(DOCS)) {
    it(`${kind}: no key outside RDF_READ_FIELDS is read, and no local-only value reaches a triple`, () => {
      const allowed = new Set(readFields()[kind]);
      assert.ok(allowed.size > 0, `RDF_READ_FIELDS.${kind} is a non-empty list`);
      const touched = new Set();
      const spy = new Proxy(doc, { get: (t, k) => { touched.add(String(k)); return t[k]; }, has: (t, k) => { touched.add(String(k)); return k in t; }, ownKeys: (t) => { touched.add('*ownKeys'); return Reflect.ownKeys(t); } });
      const { quads } = run(kind, spy);
      assert.ok(quads.length > 0);
      const outside = [...touched].filter((k) => !allowed.has(k) && k !== '*ownKeys' && k !== 'then' && !k.startsWith('Symbol('));
      assert.deepEqual(outside, [], `${kind} read fields outside RDF_READ_FIELDS`);
      const text = JSON.stringify(quads);
      for (const secret of ['MATCHED', 'GUARD']) assert.ok(!text.includes(secret), `${secret} must not reach the form`);
    });
  }
});
