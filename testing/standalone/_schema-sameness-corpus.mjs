/**
 * The corpus of schema version texts the Q-744 sameness tests run over (bundle-268, design r2 §0 E1/E2, r3 T1, r4 §10 T1 and T7): every
 * distinct text of the probe's 34 pairs, the two unread texts, and the extra shapes aimed at the diff's normalisation, built by the
 * schema package's own fingerprint text so each one is a text a real space could hold.
 *
 * ## The question it answers
 *
 * *"Which texts does the diff's per-type sameness have to hold over?"* T1 (the relation is an equivalence, the grouping is its partition)
 * and T7 (the reach law of `narrowedDiff`) both ask it; a second copy would drift in the one shape that decides an answer.
 *
 * ## What it prevents
 *
 * **A shrunk corpus passing.** The probe ran over 44 distinct texts, 7 of them with unread places (log/b268-probe/t2-e1-e2.log). The
 * tests assert that floor, so a corpus that lost its counterexample triple or its unread texts is a red, never a quieter pass.
 * **A text no space could hold.** A shape the fingerprint text refuses is left out here, as the probe left it out, never typed by hand.
 */

const P = { type: 'string' };
const BASE = { entity: { Person: { propertySchemas: { name: P } }, Org: { description: 'an org' } }, fact: { Note: {} } };
const RULE = { rule: 'true', message: 'ok' };
const clone = (o) => JSON.parse(JSON.stringify(o));
const with_ = (f, b = BASE) => { const t = clone(b); f(t); return t; };

/** [label, typeSchemas A, rules A, typeSchemas B, rules B]: the probe's 34 pairs (t1-key-vs-diff.mjs). */
const PAIRS = [
  ['identical', BASE, {}, BASE, {}],
  ['key order only', BASE, {}, { fact: { Note: {} }, entity: { Org: { description: 'an org' }, Person: { propertySchemas: { name: { type: 'string' } } } } }, {}],
  ['structural: prop type', BASE, {}, with_(t => { t.entity.Person.propertySchemas.name = { type: 'number' }; }), {}],
  ['structural: prop added', BASE, {}, with_(t => { t.entity.Person.propertySchemas.age = { type: 'number' }; }), {}],
  ['structural: required', BASE, {}, with_(t => { t.entity.Person.propertySchemas.name.required = true; }), {}],
  ['wording: type description', BASE, {}, with_(t => { t.entity.Org.description = 'another'; }), {}],
  ['wording: prop description', BASE, {}, with_(t => { t.entity.Person.propertySchemas.name.description = 'd'; }), {}],
  ['write: mergeFn', with_(t => { t.entity.Person.propertySchemas.age = { type: 'number' }; }), {}, with_(t => { t.entity.Person.propertySchemas.age = { type: 'number', mergeFn: 'avg' }; }), {}],
  ['write: default', BASE, {}, with_(t => { t.entity.Person.propertySchemas.name.default = 'x'; }), {}],
  ['lifecycle: retention', BASE, {}, with_(t => { t.entity.Person.retention = { days: 30 }; }), {}],
  ['lifecycle: suppressEmbeddings', BASE, {}, with_(t => { t.entity.Person.suppressEmbeddings = true; }), {}],
  ['type rule added', BASE, {}, with_(t => { t.entity.Person.rules = { r: RULE }; }), {}],
  ['type rule message', with_(t => { t.entity.Person.rules = { r: RULE }; }), {}, with_(t => { t.entity.Person.rules = { r: { ...RULE, message: 'm2' } }; }), {}],
  ['type added', BASE, {}, with_(t => { t.entity.Place = {}; }), {}],
  ['type removed', BASE, {}, with_(t => { delete t.entity.Org; }), {}],
  ['library $ref swapped', with_(t => { t.entity.Person = { $ref: 'library:PersonV1' }; }), {}, with_(t => { t.entity.Person = { $ref: 'library:PersonV2' }; }), {}],
  ['$ref vs inline', with_(t => { t.entity.Person = { $ref: 'library:PersonV1' }; }), {}, BASE, {}],
  ['space rule added (no kinds)', BASE, {}, BASE, { s: RULE }],
  ['space rule added (entity)', BASE, {}, BASE, { s: { ...RULE, kinds: ['entity'] } }],
  ['space rule removed', BASE, { s: { ...RULE, kinds: ['fact'] } }, BASE, {}],
  ['space rule renamed', BASE, { s: { ...RULE, kinds: ['fact'] } }, BASE, { s2: { ...RULE, kinds: ['fact'] } }],
  ['space rule reworded', BASE, { s: { ...RULE, kinds: ['fact'] } }, BASE, { s: { ...RULE, message: 'other', kinds: ['fact'] } }],
  ['space rule kinds narrowed', BASE, { s: { ...RULE, kinds: ['fact', 'entity'] } }, BASE, { s: { ...RULE, kinds: ['entity'] } }],
  ['space rule kinds widened', BASE, { s: { ...RULE, kinds: ['entity'] } }, BASE, { s: { ...RULE, kinds: ['entity', 'edge'] } }],
  ['space rule kinds -> none', BASE, { s: { ...RULE, kinds: ['entity'] } }, BASE, { s: RULE }],
  ['space rule kinds [] vs absent', BASE, { s: { ...RULE, kinds: [] } }, BASE, { s: RULE }],
  ['space rule kinds reordered', BASE, { s: { ...RULE, kinds: ['fact', 'entity'] } }, BASE, { s: { ...RULE, kinds: ['entity', 'fact'] } }],
  ['kind first type (edge)', BASE, {}, with_(t => { t.edge = { knows: {} }; }), {}],
  ['kind last type removed (fact)', BASE, {}, with_(t => { delete t.fact; }), {}],
  ['empty propertySchemas added', BASE, {}, with_(t => { t.fact.Note = { propertySchemas: {} }; }), {}],
  ['empty retention added', BASE, {}, with_(t => { t.fact.Note = { retention: {} }; }), {}],
  ['empty endpoints added', BASE, {}, with_(t => { t.fact.Note = { endpoints: {} }; }), {}],
  ['empty type rules added', BASE, {}, with_(t => { t.fact.Note = { rules: {} }; }), {}],
  ['empty prop schema entry', BASE, {}, with_(t => { t.entity.Person.propertySchemas.extra = {}; }), {}],
];

/** [label, typeSchemas, rules]: shapes at the normalisation's edges; one the fingerprint text refuses is left out. */
const EXTRAS = [
  ['x: Note both empty maps', with_(t => { t.fact.Note = { propertySchemas: {}, rules: {} }; }), {}],
  ['x: Note rules+prop entry', with_(t => { t.fact.Note = { rules: {}, propertySchemas: { a: P } }; }), {}],
  ['x: Note prop entry', with_(t => { t.fact.Note = { propertySchemas: { a: P } }; }), {}],
  ['x: Note null propertySchemas', with_(t => { t.fact.Note = { propertySchemas: null }; }), {}],
  ['x: ref + empty props', with_(t => { t.entity.Person = { $ref: 'library:PersonV1', propertySchemas: {} }; }), {}],
  ['x: ref', with_(t => { t.entity.Person = { $ref: 'library:PersonV1' }; }), {}],
  ['x: fact rule + Note props{}', with_(t => { t.fact.Note = { propertySchemas: {} }; }), { s: { ...RULE, kinds: ['fact'] } }],
  ['x: fact rule', BASE, { s: { ...RULE, kinds: ['fact'] } }],
  ['x: fact rule kinds [fact,fact]', BASE, { s: { ...RULE, kinds: ['fact', 'fact'] } }],
  ['x: fact map empty', with_(t => { t.fact = {}; }), {}],
  ['x: Person props{} only', with_(t => { t.entity.Person = { propertySchemas: {} }; }), {}],
  ['x: Person no props', with_(t => { t.entity.Person = {}; }), {}],
  ['x: edge knows endpoints{}', with_(t => { t.edge = { knows: { endpoints: {} } }; }), {}],
];

/** Texts a newer release could have written: an unknown envelope key and an unknown type field. */
const UNREAD = [
  ['unread envelope key', JSON.stringify({ format: 1, typeSchemas: BASE, rules: {}, future: 1 })],
  ['unread type field', JSON.stringify({ format: 1, rules: {}, typeSchemas: { entity: { Person: { propertySchemas: { name: { type: 'string' } }, futureField: 1 } } } })],
];

/** The texts the counterexample triple of r2 §0 is made of (fact/Note: bare, empty propertySchemas, empty rules). */
export const TRIPLE = Object.freeze(['identical#A','empty propertySchemas added#B', 'empty type rules added#B']);

/**
 * Every distinct corpus text once, in a fixed order: `[{ label, text }]`. The first label a text was reached under is kept.
 * @returns the corpus, built by the schema package's `schemaFingerprintTextOf`.
 */
export async function samenessCorpus() {
  const { schemaFingerprintTextOf } = await import('../../schema/dist/internal.js');
  const textOf = (typeSchemas, rules) => schemaFingerprintTextOf({ typeSchemas, rules });
  const texts = new Map();
  const add = (label, text) => { if (!texts.has(text)) texts.set(text, label); };
  for (const [n, ta, ra, tb, rb] of PAIRS) { add(`${n}#A`, textOf(ta, ra)); add(`${n}#B`, textOf(tb, rb)); }
  for (const [n, text] of UNREAD) add(n, text);
  for (const [n, ts, rs] of EXTRAS) {
    let t;
    try { t = textOf(ts, rs); } catch { continue; }
    add(n, t);
  }
  return [...texts].map(([text, label]) => ({ label, text }));
}

/** The corpus's floor: what the probe ran over. */
export const CORPUS_FLOOR = Object.freeze({ texts: 44, unread: 7 });
