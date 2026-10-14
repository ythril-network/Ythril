/**
 * A property key the type does not declare is judged alike on EVERY REST door that stores a record (`Q-93`).
 *
 * ## The rule
 *
 * A type that declares at least one property in its `propertySchemas` is a closed list. A write that ADDS a key outside
 * it is refused in a `strict` space (nothing stored), stored and FLAGGED in a `warn` space, and ignored in an `off`
 * space. A type with no `propertySchemas`, or with `propertySchemas: {}`, is open and the rule is silent in every mode.
 * A key already stored on the record is pre-existing: only what the write ADDS is introduced (a retype introduces the
 * keys the new type does not declare and the old one did, or the old one, being open, never judged).
 *
 * ## What was true before it (the base this file is written against)
 *
 * `validatePropertiesAgainstSchema` checks the declared keys' values and nothing else, so every door below stores an
 * undeclared key in every mode, and the one rule that fills the gap is a value shape (`primitivePropertyError`: a
 * nested or null value on an entity). The rule cases here therefore go red on the base for "strict stored a record
 * carrying the key" or "no warning row names it"; the CONTROLS (a declared key, an open type, a key already stored, the
 * value-shape refusal) are green on it and must stay green.
 *
 * ## The doors, and why the list is derived
 *
 * Every REST route that stores a record from a body is read out of the router source (`mountedRoutesWithSource`):
 * `POST`/`PATCH` on `/spaces/:spaceId/<kind>[/:id]` for each of the four kinds, and the bulk route. A table written by hand
 * is the door added next year simply not in it, so `the doors under test are the doors the router mounts` holds the table
 * to what the source registers and floors the count. The per-kind REQUEST BUILDERS are fixtures and stay literal.
 *
 * ## What each answer is read as
 *
 * A single-record door refuses with a status `>= 400` and a body that names the key; a bulk door answers `207` and the
 * refusal is an `errors` row for the item (the other items are written). A warning is a row in the answer's `warnings`
 * array whose `field` is `properties.<key>` (bulk: an `errors` row beginning `schema_warning`). "Stored" and "nothing
 * stored" are read from the store, by a marker in each record's `description` or by the key itself.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=<port> node --test testing/standalone/an-undeclared-property-key-is-judged-alike-on-every-rest-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import {
  openUndeclaredKeyDoors, MODES, spaceOf, UNDECLARED, DECLARED, DECLARING, OPEN, EMPTY_DECLARED_ENTITY,
  COLLECTION, storedWithKey,
} from './_undeclared-key-doors.mjs';

const skip = await mongoSkipReason();

/** A fifth space, strict, whose entity types differ in WHAT they declare — the retype cases need two declaring types. */
const RETYPE = 'undeclkeysretype';
const retypeSpace = () => ({
  id: RETYPE, label: RETYPE, folders: [], completeLinkage: true,
  meta: {
    validationMode: 'strict', suppressEmbeddings: true,
    typeSchemas: {
      entity: {
        service: { propertySchemas: { status: { type: 'string' } } },
        gadget: { propertySchemas: { version: { type: 'string' } } },
        scratch: {},
      },
    },
  },
});

const env = skip ? null : await openUndeclaredKeyDoors({ suite: 'undeclkeysrest', extraSpaces: [retypeSpace()] });
after(async () => { await env?.close(); });
const { door, rest } = env ?? {};

// ── Fixtures: literal on purpose (a fixture that derived its expectations from the server would assert it equals itself) ──

const IDS = Object.freeze({
  A: 'dddddddd-0000-4000-8000-0000000000a1',
  B: 'dddddddd-0000-4000-8000-0000000000b2',
  C: 'dddddddd-0000-4000-8000-0000000000c3',
  P_ENTITY: 'dddddddd-0000-4000-8000-00000000e001',
  P_FACT: 'dddddddd-0000-4000-8000-00000000f001',
  P_CHRONO: 'dddddddd-0000-4000-8000-00000000c001',
  P_EDGE: 'dddddddd-0000-4000-8000-00000000d001',
  PRE: 'dddddddd-0000-4000-8000-00000000e0aa',
  CAP: 'dddddddd-0000-4000-8000-00000000e0cc',
});
const SEED = 'as seeded';
const EDITED = 'as edited by the door';
const KINDS = ['entity', 'fact', 'chrono', 'edge'];
const SEGMENT = { entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges' };
const BULK_KEY = SEGMENT;
const TYPE_OF = { entity: 'service', fact: 'note', chrono: 'release', edge: 'depends_on' };
const bodyPath = (space, tail) => `/api/brain/spaces/${space}/${tail}`;

/** The body each kind's create door (and a bulk item) takes. `over` replaces fields; `description` is the marker a case finds the record by. */
const CREATE = {
  entity: (m, properties, over = {}) => ({ name: `name ${m}`, type: TYPE_OF.entity, description: m, properties, ...over }),
  fact: (m, properties, over = {}) => ({ fact: `fact ${m}`, type: TYPE_OF.fact, description: m, properties, ...over }),
  chrono: (m, properties, over = {}) => ({ title: `title ${m}`, type: TYPE_OF.chrono, startsAt: '2026-10-01T00:00:00.000Z', description: m, properties, ...over }),
  edge: (m, properties, over = {}) => ({ from: IDS.A, to: IDS.B, label: TYPE_OF.edge, description: m, properties, ...over }),
};
const SEEDED_ID = { entity: IDS.P_ENTITY, fact: IDS.P_FACT, chrono: IDS.P_CHRONO, edge: IDS.P_EDGE };

/** Empty `space` and store what every case reads or edits: three entity ends and one record per kind, each of the declaring type with its declared key. */
async function fresh(space) {
  await door.wipe(space);
  await door.setCounter(space, 10);
  await door.coll(space, 'entities').insertMany([
    build.entity(space, IDS.A, 3, { name: 'End A', type: OPEN.entity }),
    build.entity(space, IDS.B, 3, { name: 'End B', type: OPEN.entity }),
    build.entity(space, IDS.C, 3, { name: 'End C', type: OPEN.entity }),
    build.entity(space, IDS.P_ENTITY, 3, { name: 'Seeded service', type: TYPE_OF.entity, description: SEED, properties: { [DECLARED.entity]: 'up' } }),
  ]);
  await door.coll(space, 'facts').insertOne(build.fact(space, IDS.P_FACT, 3, { fact: 'Seeded note', type: TYPE_OF.fact, description: SEED, properties: { [DECLARED.fact]: 'low' } }));
  await door.coll(space, 'chrono').insertOne(build.chrono(space, IDS.P_CHRONO, 3, { title: 'Seeded release', type: TYPE_OF.chrono, description: SEED, properties: { [DECLARED.chrono]: '1' } }));
  await door.coll(space, 'edges').insertOne(build.edge(space, IDS.P_EDGE, 3, { from: IDS.B, to: IDS.C, label: TYPE_OF.edge, description: SEED, properties: { [DECLARED.edge]: 'a' } }));
}

const byMarker = async (space, kind, marker) => door.coll(space, COLLECTION[kind]).find({ description: marker }).toArray();
const storedById = async (space, kind, id) => door.coll(space, COLLECTION[kind]).findOne({ _id: id });

/**
 * Whether `text` names `key` AS undeclared: the key, and the word `declared` somewhere OTHER than inside the key. The shared
 * `namesTheKey` cannot be used for this file — the fixture's own key is `zzNotDeclared`, which contains the word, so
 * it is true of any answer that merely echoes the stored record, and an `off` or open-type case would read the echo as a flag.
 */
const namesIt = (text, key = UNDECLARED) => text.includes(key) && /declared/i.test(text.split(key).join(''));

/** The rows of a single-record answer's `warnings` array. */
const warningRows = (answer) => (Array.isArray(answer.body?.warnings) ? answer.body.warnings : []);
/** Whether the answer carries a warning row for `key` in the validator's own, fixed shape. */
const flagsKey = (answer, key = UNDECLARED) => warningRows(answer).some(w => w?.field === `properties.${key}`);
/** Whether the answer warns about ANY property at all — what a declared key or an open type must not draw. */
const flagsAnyProperty = (answer) => warningRows(answer).some(w => typeof w?.field === 'string' && w.field.includes('properties.'));
/** The bulk `errors` row for the item at `index` of `kind`, or `undefined`. */
const bulkRow = (answer, kind, index = 0) => (Array.isArray(answer.body?.errors) ? answer.body.errors : []).find(e => e.index === index && e.type === kind);
const isWarningRow = (row) => typeof row?.reason === 'string' && row.reason.startsWith('schema_warning');

// ── The doors ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each door: `{ name, route: [method, path], kind, verb, send(space, props, marker, extra), refused(answer), flagged(answer), named(answer), ... }`.
 *
 * `send` stores (or edits) a record carrying `props` and answers what the door answered. `extra` is merged into the record
 * (inline `edges`). A patch door edits the seeded record of its kind, so a refusal is read against what it was seeded as.
 */
function doorsOf(kind) {
  const seg = SEGMENT[kind];
  const create = {
    name: `POST ${seg}`, route: ['POST', `/api/brain/spaces/:spaceId/${seg}`], kind, verb: 'create',
    send: (space, props, marker, extra = {}, over = {}) => rest('POST', bodyPath(space, seg), { ...CREATE[kind](marker, props, over), ...extra }),
    refused: (a) => a.status >= 400,
    flagged: (a) => flagsKey(a),
    flaggedAnyProperty: (a) => flagsAnyProperty(a),
    named: (a) => namesIt(a.text),
    /** Records of this kind that landed for `marker`. */
    landed: (space, marker) => byMarker(space, kind, marker),
  };
  const patch = {
    name: `PATCH ${seg}/:id`, route: ['PATCH', `/api/brain/spaces/:spaceId/${seg}/:id`], kind, verb: 'patch',
    send: (space, props, marker, extra = {}) => rest('PATCH', bodyPath(space, `${seg}/${SEEDED_ID[kind]}`), { description: EDITED, properties: props, ...extra }),
    refused: create.refused, flagged: create.flagged, flaggedAnyProperty: create.flaggedAnyProperty, named: create.named,
    /** The seeded record, when the patch landed (its description is the edit); an empty list when it did not. */
    landed: async (space) => {
      const r = await storedById(space, kind, SEEDED_ID[kind]);
      return r && r.description === EDITED ? [r] : [];
    },
  };
  const bulk = {
    name: `POST bulk (${BULK_KEY[kind]})`, route: ['POST', '/api/brain/spaces/:spaceId/bulk'], kind, verb: 'bulk',
    /** Item 0 carries `props`; item 1 is a clean sibling, to show "other items written". */
    send: (space, props, marker, extra = {}) => rest('POST', bodyPath(space, 'bulk'), {
      [BULK_KEY[kind]]: [
        { ...CREATE[kind](marker, props), ...extra },
        CREATE[kind](`${marker} sibling`, { [DECLARED[kind]]: 'v' }, kind === 'edge' ? { to: IDS.C } : {}),
      ],
    }),
    refused: (a) => { const row = bulkRow(a, kind); return a.status === 207 && !!row && !isWarningRow(row); },
    flagged: (a) => { const row = bulkRow(a, kind); return isWarningRow(row) && row.reason.includes(`properties.${UNDECLARED}`); },
    flaggedAnyProperty: (a) => (Array.isArray(a.body?.errors) ? a.body.errors : []).some(isWarningRow),
    named: (a) => { const row = bulkRow(a, kind); return !!row && namesIt(JSON.stringify(row)); },
    landed: (space, marker) => byMarker(space, kind, marker),
    sibling: (space, marker) => byMarker(space, kind, `${marker} sibling`),
  };
  return [create, patch, bulk];
}
const DOORS = KINDS.flatMap(doorsOf);

describe('an undeclared property key is judged alike on every REST door', { skip }, () => {
  it('the doors under test are the doors the router mounts', () => {
    // Derived from the router source: every POST/PATCH that stores a record from a body, under the brain API.
    const mounted = mountedRoutesWithSource().filter(r => r.path.startsWith('/api/brain/') && (r.method === 'POST' || r.method === 'PATCH'));
    const storing = mounted.filter(r => /\b(upsert(Entity|Edge|Fact|Chrono)|update(Entity|Edge|Fact|Chrono)ById|bulkWrite)\s*\(/.test(r.source)
      || new RegExp(`^/api/brain/spaces/:spaceId/(${Object.values(SEGMENT).join('|')})(/:id)?$`).test(r.path));
    const derived = new Set(storing.map(r => `${r.method} ${r.path}`));
    assert.ok(derived.size >= 9, `only ${derived.size} storing REST doors derived — the derivation stopped matching: ${[...derived]}`);
    const mine = new Set(DOORS.map(d => `${d.route[0]} ${d.route[1]}`));
    const missing = [...derived].filter(k => !mine.has(k));
    assert.deepEqual(missing, [], `a REST door stores a record from a body and this file holds no case for it: ${missing}`);
    const gone = [...mine].filter(k => !derived.has(k));
    assert.deepEqual(gone, [], `this file drives a door the router no longer mounts: ${gone}`);
  });

  for (const d of DOORS) {
    describe(`${d.name} (${d.kind})`, () => {
      it('control: a declared key is accepted and flagged in no mode', async () => {
        for (const mode of MODES) {
          const space = spaceOf(mode);
          await fresh(space);
          const marker = `declared-${d.kind}-${d.verb}-${mode}`;
          const answer = await d.send(space, { [DECLARED[d.kind]]: 'v' }, marker);
          assert.equal(d.refused(answer), false, `${mode}: a declared key was refused: ${answer.status} ${answer.text.slice(0, 300)}`);
          assert.equal(d.flaggedAnyProperty(answer), false, `${mode}: a declared key was flagged: ${answer.text.slice(0, 300)}`);
          const landed = await d.landed(space, marker);
          assert.equal(landed.length, 1, `${mode}: the record with a declared key did not land`);
          assert.equal(landed[0].properties?.[DECLARED[d.kind]], 'v', `${mode}: the declared key was not stored`);
          if (d.verb === 'bulk') assert.equal((await d.sibling(space, marker)).length, 1, `${mode}: the clean sibling item was not written`);
        }
      });

      it('strict: an added undeclared key is refused, the answer names it, and nothing is stored', async () => {
        const space = spaceOf('strict');
        await fresh(space);
        const marker = `strict-${d.kind}-${d.verb}`;
        const answer = await d.send(space, { [UNDECLARED]: 'x' }, marker);
        assert.equal(d.refused(answer), true, `strict accepted a write that adds the undeclared key \`${UNDECLARED}\` (${answer.status}): ${answer.text.slice(0, 300)}`);
        assert.equal(d.named(answer), true, `the refusal does not name the undeclared key: ${answer.text.slice(0, 400)}`);
        const stored = await storedWithKey(door, space, d.kind);
        assert.deepEqual(stored.map(r => r._id), [], `strict stored a record carrying the undeclared key: ${JSON.stringify(stored.map(r => r._id))}`);
        assert.deepEqual((await d.landed(space, marker)).map(r => r._id), [], 'the refused write left a record behind');
        if (d.verb === 'patch') {
          const seeded = await storedById(space, d.kind, SEEDED_ID[d.kind]);
          assert.equal(seeded.description, SEED, 'a refused patch changed the record\'s other fields: it must be refused as a whole');
        }
        if (d.verb === 'bulk') {
          assert.equal((await d.sibling(space, marker)).length, 1, 'the refused item took the clean item of the same call with it');
        }
      });

      it('warn: the write lands and the answer flags the undeclared key', async () => {
        const space = spaceOf('warn');
        await fresh(space);
        const marker = `warn-${d.kind}-${d.verb}`;
        const answer = await d.send(space, { [UNDECLARED]: 'x' }, marker);
        assert.equal(d.refused(answer), false, `warn refused a write: ${answer.status} ${answer.text.slice(0, 300)}`);
        assert.equal(d.flagged(answer), true, `no warning row for \`properties.${UNDECLARED}\` in the answer: ${answer.text.slice(0, 500)}`);
        const stored = await storedWithKey(door, space, d.kind);
        assert.equal(stored.length, 1, 'warn did not store the record carrying the key');
      });

      it('off: the write lands and nothing says anything about the key', async () => {
        const space = spaceOf('off');
        await fresh(space);
        const marker = `off-${d.kind}-${d.verb}`;
        const answer = await d.send(space, { [UNDECLARED]: 'x' }, marker);
        assert.equal(d.refused(answer), false, `off refused a write: ${answer.status} ${answer.text.slice(0, 300)}`);
        assert.equal(d.flagged(answer), false, `off flagged the key: ${answer.text.slice(0, 300)}`);
        assert.equal(d.flaggedAnyProperty(answer), false, `off carries a property warning: ${answer.text.slice(0, 300)}`);
        assert.equal(d.named(answer), false, `off names the key as a problem: ${answer.text.slice(0, 300)}`);
        assert.equal((await storedWithKey(door, space, d.kind)).length, 1, 'off did not store the record carrying the key');
      });
    });
  }
});

// ── Inline edges on a record write ────────────────────────────────────────────────────────────────────────────────

/**
 * An inline edge whose label DECLARES properties and carries one it does not. The existing inline-edge rule
 * (`_inline-edge-doors.mjs`) is that a refused edge refuses the WHOLE write: no record, no edge. The record itself is of an
 * open type (create) or carries only its declared key (patch), so the edge's key is the only thing that can refuse it.
 */
const inlineEdge = () => ({ to: IDS.B, label: DECLARING.edge, properties: { [UNDECLARED]: 'x' } });
const INLINE_RECORD_TYPE = { entity: OPEN.entity, fact: OPEN.fact, chrono: OPEN.chrono };
const INLINE = [];
for (const kind of ['entity', 'fact', 'chrono']) {
  const [create, patch, bulk] = doorsOf(kind);
  INLINE.push({
    ...create, name: `POST ${SEGMENT[kind]} with an inline edge`,
    send: (space, marker) => create.send(space, {}, marker, { edges: [inlineEdge()] }, { type: INLINE_RECORD_TYPE[kind] }),
  });
  INLINE.push({ ...patch, name: `PATCH ${SEGMENT[kind]}/:id with an inline edge`, send: (space, marker) => patch.send(space, { [DECLARED[kind]]: 'v' }, marker, { edges: [inlineEdge()] }) });
  if (kind === 'entity') {
    INLINE.push({
      ...bulk, name: 'POST bulk (entities) with an inline edge',
      send: (space, marker) => rest('POST', bodyPath(space, 'bulk'), {
        entities: [
          { ...CREATE.entity(marker, {}, { type: OPEN.entity }), edges: [inlineEdge()] },
          CREATE.entity(`${marker} sibling`, { [DECLARED.entity]: 'v' }),
        ],
      }),
      named: (a) => { const row = bulkRow(a, 'entity'); return !!row && namesIt(JSON.stringify(row)); },
      flagged: (a) => { const row = bulkRow(a, 'entity'); return isWarningRow(row) && namesIt(row.reason); },
    });
  }
}
/** Whether the answer warns about the inline edge's key — the field is the edge's own path, so the key is read from the row's text. */
const inlineFlagged = (door_, a) => (door_.verb === 'bulk' ? door_.flagged(a) : namesIt(JSON.stringify(warningRows(a))));
const edgesWithKey = async (space) => storedWithKey(door, space, 'edge');

describe('an inline edge with an undeclared property key is judged alike on every REST door', { skip }, () => {
  it('the inline-edge doors cover the three record kinds and the bulk item', () => {
    assert.ok(INLINE.length >= 7, `only ${INLINE.length} inline-edge doors`);
  });

  for (const d of INLINE) {
    describe(d.name, () => {
      it('strict: the whole write is refused — no record, no edge — and the answer names the key', async () => {
        const space = spaceOf('strict');
        await fresh(space);
        const marker = `inline-strict-${d.kind}-${d.verb}`;
        const answer = await d.send(space, marker);
        assert.equal(d.refused(answer), true, `strict accepted an inline edge carrying the undeclared key (${answer.status}): ${answer.text.slice(0, 300)}`);
        assert.equal(d.named(answer), true, `the refusal does not name the undeclared key: ${answer.text.slice(0, 400)}`);
        assert.deepEqual((await edgesWithKey(space)).map(e => e._id), [], 'strict stored the inline edge carrying the undeclared key');
        assert.deepEqual((await d.landed(space, marker)).map(r => r._id), [], 'the refused write left its record behind');
        if (d.verb === 'patch') assert.equal((await storedById(space, d.kind, SEEDED_ID[d.kind])).description, SEED, 'a refused patch changed the record');
        if (d.verb === 'bulk') assert.equal((await d.sibling(space, marker)).length, 1, 'the refused item took the clean item of the same call with it');
      });

      it('warn: record and edge land and the answer flags the key', async () => {
        const space = spaceOf('warn');
        await fresh(space);
        const marker = `inline-warn-${d.kind}-${d.verb}`;
        const answer = await d.send(space, marker);
        assert.equal(d.refused(answer), false, `warn refused: ${answer.status} ${answer.text.slice(0, 300)}`);
        assert.equal(inlineFlagged(d, answer), true, `no warning names the inline edge's undeclared key: ${answer.text.slice(0, 500)}`);
        assert.equal((await edgesWithKey(space)).length, 1, 'warn did not store the edge carrying the key');
        assert.equal((await d.landed(space, marker)).length, 1, 'warn did not store the record');
      });

      it('off: record and edge land and nothing is said about the key', async () => {
        const space = spaceOf('off');
        await fresh(space);
        const marker = `inline-off-${d.kind}-${d.verb}`;
        const answer = await d.send(space, marker);
        assert.equal(d.refused(answer), false, `off refused: ${answer.status} ${answer.text.slice(0, 300)}`);
        assert.equal(inlineFlagged(d, answer), false, `off flagged the inline edge's key: ${answer.text.slice(0, 300)}`);
        assert.equal(d.named(answer), false, `off names the key as a problem: ${answer.text.slice(0, 300)}`);
        assert.equal((await edgesWithKey(space)).length, 1, 'off did not store the edge carrying the key');
        if (d.verb === 'bulk') assert.equal((await d.sibling(space, marker)).length, 1, 'the clean sibling item was not written');
      });
    });
  }
});

// ── (1) Open types are silent in every mode ───────────────────────────────────────────────────────────────────────────

describe('an open type is silent about an undeclared key', { skip }, () => {
  /** A type with no `propertySchemas` and one with `propertySchemas: {}` are both open — an empty list is not a closed one. */
  const OPEN_CREATES = [
    { label: `entity \`${OPEN.entity}\` (no propertySchemas)`, kind: 'entity', make: (m, p) => CREATE.entity(m, p, { type: OPEN.entity }) },
    { label: `entity \`${EMPTY_DECLARED_ENTITY}\` (propertySchemas {})`, kind: 'entity', make: (m, p) => CREATE.entity(m, p, { type: EMPTY_DECLARED_ENTITY }) },
    { label: `fact \`${OPEN.fact}\``, kind: 'fact', make: (m, p) => CREATE.fact(m, p, { type: OPEN.fact }) },
    { label: `chrono \`${OPEN.chrono}\``, kind: 'chrono', make: (m, p) => CREATE.chrono(m, p, { type: OPEN.chrono }) },
    { label: `edge \`${OPEN.edge}\``, kind: 'edge', make: (m, p) => CREATE.edge(m, p, { label: OPEN.edge }) },
  ];
  for (const c of OPEN_CREATES) {
    it(`strict and warn accept an undeclared key on ${c.label}, flagging nothing`, async () => {
      for (const mode of ['strict', 'warn']) {
        const space = spaceOf(mode);
        await fresh(space);
        const marker = `open-${c.kind}-${mode}`;
        const answer = await rest('POST', bodyPath(space, SEGMENT[c.kind]), c.make(marker, { [UNDECLARED]: 'x' }));
        assert.ok(answer.status < 300, `${mode}: an open type refused the key (${answer.status}): ${answer.text.slice(0, 300)}`);
        assert.equal(flagsAnyProperty(answer), false, `${mode}: an open type flagged the key: ${answer.text.slice(0, 300)}`);
        assert.equal(namesIt(answer.text), false, `${mode}: an open type names the key as a problem: ${answer.text.slice(0, 300)}`);
        assert.equal((await byMarker(space, c.kind, marker)).length, 1, `${mode}: the record did not land`);
        assert.equal((await storedWithKey(door, space, c.kind)).length, 1, `${mode}: the key was not stored`);
      }
    });
  }

  it('strict accepts an undeclared key added by a PATCH to a record of an open type', async () => {
    const space = spaceOf('strict');
    await fresh(space);
    const answer = await rest('PATCH', bodyPath(space, `entities/${IDS.A}`), { properties: { [UNDECLARED]: 'x' } });
    assert.equal(answer.status, 200, `an open type refused a patched key: ${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal(namesIt(answer.text), false, `an open type names the key as a problem: ${answer.text.slice(0, 300)}`);
    assert.equal((await storedById(space, 'entity', IDS.A)).properties[UNDECLARED], 'x');
  });
});

// ── (2) A key already stored stays editable (P-6) ─────────────────────────────────────────────────────────────────────

describe('a key already stored on the record is pre-existing, never refused', { skip }, () => {
  const LEGACY = 'legacyKey';
  const seedPre = async (space) => {
    await fresh(space);
    await door.coll(space, 'entities').insertOne(build.entity(space, IDS.PRE, 3, {
      name: 'Pre-existing', type: TYPE_OF.entity, description: SEED, properties: { [DECLARED.entity]: 'up', [LEGACY]: 'old' },
    }));
  };
  const patchPre = (space, body) => rest('PATCH', bodyPath(space, `entities/${IDS.PRE}`), body);

  it('control: strict accepts a PATCH of the description of a record holding an undeclared key', async () => {
    const space = spaceOf('strict');
    await seedPre(space);
    const answer = await patchPre(space, { description: EDITED });
    assert.equal(answer.status, 200, `a key the record already held blocked an unrelated edit: ${answer.status} ${answer.text.slice(0, 300)}`);
    const stored = await storedById(space, 'entity', IDS.PRE);
    assert.equal(stored.description, EDITED);
    assert.equal(stored.properties[LEGACY], 'old', 'the stored undeclared key was lost');
  });

  it('control: strict accepts a PATCH that changes the VALUE of the stored undeclared key', async () => {
    const space = spaceOf('strict');
    await seedPre(space);
    const answer = await patchPre(space, { properties: { [LEGACY]: 'new' } });
    assert.equal(answer.status, 200, `changing the value of a stored key was refused: ${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal((await storedById(space, 'entity', IDS.PRE)).properties[LEGACY], 'new');
  });

  it('strict refuses a PATCH that adds a SECOND undeclared key, and changes nothing', async () => {
    const space = spaceOf('strict');
    await seedPre(space);
    const answer = await patchPre(space, { description: EDITED, properties: { [UNDECLARED]: 'x' } });
    assert.ok(answer.status >= 400, `strict accepted a second undeclared key (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.equal(namesIt(answer.text), true, `the refusal does not name the added key: ${answer.text.slice(0, 400)}`);
    // The body may LIST the pre-existing key (a `preExisting` array); what it must not do is call it introduced.
    assert.doesNotMatch(JSON.stringify(answer.body?.introduced ?? []), new RegExp(LEGACY), `the refusal calls the key the record already held introduced: ${answer.text.slice(0, 400)}`);
    const stored = await storedById(space, 'entity', IDS.PRE);
    assert.equal(stored.properties[UNDECLARED], undefined, 'the refused key was stored');
    assert.equal(stored.description, SEED, 'the refused patch changed another field');
  });

  it('strict refuses a PATCH that changes the stored key AND adds a new one, whole', async () => {
    const space = spaceOf('strict');
    await seedPre(space);
    const answer = await patchPre(space, { properties: { [LEGACY]: 'new', [UNDECLARED]: 'x' } });
    assert.ok(answer.status >= 400, `strict accepted an added key next to a changed stored one (${answer.status}): ${answer.text.slice(0, 300)}`);
    const stored = await storedById(space, 'entity', IDS.PRE);
    assert.equal(stored.properties[LEGACY], 'old', 'the refused patch changed the stored key');
    assert.equal(stored.properties[UNDECLARED], undefined);
  });
});

// ── (3) Retype ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a retype judges the keys the record carries against the NEW type', { skip }, () => {
  const R_ID = 'dddddddd-0000-4000-8000-00000000e0e1';
  const seed = async (type, properties) => {
    await door.wipe(RETYPE);
    await door.setCounter(RETYPE, 10);
    await door.coll(RETYPE, 'entities').insertOne(build.entity(RETYPE, R_ID, 3, { name: 'Retyped', type, description: SEED, properties }));
  };
  const retype = (body) => rest('PATCH', bodyPath(RETYPE, `entities/${R_ID}`), body);

  it('strict refuses a retype from an OPEN type that makes a stored key undeclared (introduced by the retype), changing nothing', async () => {
    // `scratch` declares nothing, so the key was never a violation there; `service` declares only `status`, so the retype introduces it.
    await seed(OPEN.entity, { legacyKey: 'old' });
    const answer = await retype({ type: 'service' });
    assert.equal(answer.status, 422, `strict accepted a retype that makes a stored key undeclared (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.equal(namesIt(answer.text, 'legacyKey'), true, `the refusal does not name the key: ${answer.text.slice(0, 400)}`);
    assert.match(JSON.stringify(answer.body?.introduced ?? []), /legacyKey/, 'the key is not in the introduced list');
    assert.equal((await storedById(RETYPE, 'entity', R_ID)).type, OPEN.entity, 'the refused retype changed the type');
  });

  it('strict refuses a retype to a type that does not declare a key the OLD type declared, changing nothing', async () => {
    await seed('service', { status: 'up' });
    const answer = await retype({ type: 'gadget' });
    assert.equal(answer.status, 422, `strict accepted a retype that makes the declared key \`status\` undeclared (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.equal(namesIt(answer.text, 'status'), true, `the refusal does not name the key: ${answer.text.slice(0, 400)}`);
    const stored = await storedById(RETYPE, 'entity', R_ID);
    assert.equal(stored.type, 'service');
    assert.equal(stored.properties.status, 'up');
  });

  it('control: a retype to an open type is accepted', async () => {
    await seed('service', { status: 'up' });
    const answer = await retype({ type: OPEN.entity });
    assert.equal(answer.status, 200, `a retype to an open type was refused: ${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal((await storedById(RETYPE, 'entity', R_ID)).type, OPEN.entity);
  });

  it('control: a key undeclared on BOTH types is pre-existing, so the retype is accepted', async () => {
    // `legacyKey` is undeclared on `service` (so it is a stored violation already) and on `gadget`: nothing new.
    await seed('service', { legacyKey: 'old' });
    const answer = await retype({ type: 'gadget' });
    assert.equal(answer.status, 200, `a retype that introduces no key was refused: ${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal((await storedById(RETYPE, 'entity', R_ID)).type, 'gadget');
  });
});

// ── (4) The cap on rows, applied after classification ─────────────────────────────────────────────────────────────────

describe('a refusal lists at most 20 violation rows and says it was cut', { skip }, () => {
  const MAX_ROWS = 20;
  /** The length of every array in the body whose elements are rows (carry a `field`). */
  const rowArrays = (body) => Object.entries(body ?? {}).filter(([, v]) => Array.isArray(v) && v.some(r => r && typeof r === 'object' && 'field' in r)).map(([k, v]) => [k, v.length]);

  it('a new key past the 20th pre-existing one is still refused, named, and the rows are capped', async () => {
    const space = spaceOf('strict');
    await fresh(space);
    const stored = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`a${String(i + 1).padStart(2, '0')}`, 'v']));
    await door.coll(space, 'entities').insertOne(build.entity(space, IDS.CAP, 3, { name: 'Many keys', type: TYPE_OF.entity, description: SEED, properties: { [DECLARED.entity]: 'up', ...stored } }));
    const answer = await rest('PATCH', bodyPath(space, `entities/${IDS.CAP}`), { properties: { 'zz-new': 'x' } });
    assert.equal(answer.status, 422, `strict accepted a new key on a record holding 25 stored undeclared keys (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.match(JSON.stringify(answer.body?.introduced ?? []), /zz-new/, 'the introduced list does not name the new key (the cap was applied before the classification)');
    for (const [name, n] of rowArrays(answer.body)) assert.ok(n <= MAX_ROWS, `\`${name}\` lists ${n} rows, above the cap of ${MAX_ROWS}`);
    assert.match(answer.text, /"truncated"\s*:\s*(true|\d+)/, 'the body does not say its rows were cut');
    assert.equal((await storedById(space, 'entity', IDS.CAP)).properties['zz-new'], undefined, 'the refused key was stored');
  });

  it('a create adding 30 undeclared keys is refused with at most 20 rows and a truncated mark', async () => {
    const space = spaceOf('strict');
    await fresh(space);
    const keys = Array.from({ length: 30 }, (_, i) => `k${String(i + 1).padStart(2, '0')}`);
    const marker = 'cap-create';
    const answer = await rest('POST', bodyPath(space, 'entities'), CREATE.entity(marker, Object.fromEntries(keys.map(k => [k, 'v']))));
    assert.ok(answer.status >= 400, `strict accepted a record adding 30 undeclared keys (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.ok(keys.some(k => answer.text.includes(k)), 'the refusal names none of the keys');
    const arrays = rowArrays(answer.body);
    assert.ok(arrays.length > 0, `the refusal carries no violation rows: ${answer.text.slice(0, 300)}`);
    for (const [name, n] of arrays) assert.ok(n <= MAX_ROWS, `\`${name}\` lists ${n} rows, above the cap of ${MAX_ROWS}`);
    assert.match(answer.text, /"truncated"\s*:\s*(true|\d+)/, 'the body does not say its rows were cut');
    assert.deepEqual((await byMarker(space, 'entity', marker)).map(r => r._id), [], 'the refused record was stored');
  });
});

// ── (5) Key edge cases, strict, create on a declaring type ────────────────────────────────────────────────────────────

describe('odd key names are judged by the same rule', { skip }, () => {
  const post = (bodyText) => fetch(`${env.base}/api/brain/spaces/${spaceOf('strict')}/entities`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' }, body: bodyText,
  }).then(async r => { const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, text }; });
  const bodyText = (marker, propertiesJson) => `{"name":"name ${marker}","type":"${TYPE_OF.entity}","description":"${marker}","properties":${propertiesJson}}`;

  /*
   * Names `Object.hasOwn` decides and a prototype lookup would get wrong: `constructor` is on every object, and a declared
   * list read with `in` or `[]` would call it declared. `__proto__` is sent as raw JSON TEXT so it arrives as an own property.
   */
  const PROTOTYPE_KEYS = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  for (const key of PROTOTYPE_KEYS) {
    it(`strict refuses the prototype-named key \`${key}\` as undeclared`, async () => {
      await fresh(spaceOf('strict'));
      const marker = `proto-${key}`;
      const answer = await post(bodyText(marker, `{${JSON.stringify(key)}:"x"}`));
      assert.ok(answer.status >= 400, `strict accepted the key \`${key}\` (${answer.status}): ${answer.text.slice(0, 300)}`);
      assert.equal(namesIt(answer.text, key), true, `the refusal does not say \`${key}\` is not declared: ${answer.text.slice(0, 400)}`);
      assert.deepEqual((await byMarker(spaceOf('strict'), 'entity', marker)).map(r => r._id), [], `the refused record with \`${key}\` was stored`);
    });
  }

  /*
   * A dotted key and a `$`-prefixed key. The base STORES both (probed: 201), so the rule is what refuses them here; if a
   * shape rule refuses them first in a later build the strict outcome is the same and stable: refused, nothing stored, the key named.
   */
  for (const key of ['a.b', '$x']) {
    it(`strict refuses the key \`${key}\`, stores nothing and names it`, async () => {
      await fresh(spaceOf('strict'));
      const marker = `shape-${key}`;
      const answer = await post(bodyText(marker, `{${JSON.stringify(key)}:"x"}`));
      assert.ok(answer.status >= 400, `strict accepted the key \`${key}\` (${answer.status}): ${answer.text.slice(0, 300)}`);
      assert.ok(answer.text.includes(key), `the refusal does not name \`${key}\`: ${answer.text.slice(0, 400)}`);
      assert.deepEqual((await byMarker(spaceOf('strict'), 'entity', marker)).map(r => r._id), [], `the refused record with \`${key}\` was stored`);
    });
  }

  it('strict refuses a 200000-character key, and the refusal is bounded', async () => {
    await fresh(spaceOf('strict'));
    const marker = 'oversized-key';
    const answer = await post(bodyText(marker, JSON.stringify({ ['k'.repeat(200_000)]: 'x' })));
    assert.ok(answer.status >= 400, `strict accepted a 200000-character key (${answer.status}): ${answer.text.slice(0, 200)}`);
    assert.ok(JSON.stringify(answer.body).length < 10_000, `the refusal quotes the key whole: ${JSON.stringify(answer.body).length} characters`);
    assert.deepEqual((await byMarker(spaceOf('strict'), 'entity', marker)).map(r => r._id), [], 'the refused record was stored');
  });

  it('control: a nested object value for an undeclared key is refused in strict and nothing is stored', async () => {
    // Refused for its own, earlier reason on the base (`primitivePropertyError`: a value must be a string, number or boolean).
    await fresh(spaceOf('strict'));
    const marker = 'nested-value';
    const answer = await post(bodyText(marker, JSON.stringify({ [UNDECLARED]: { a: 1 } })));
    assert.ok(answer.status >= 400, `strict accepted a nested value (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.deepEqual((await byMarker(spaceOf('strict'), 'entity', marker)).map(r => r._id), [], 'the refused record was stored');
  });

  /*
   * A null value is "absent". What the base answers differs by kind (an entity refuses it for the value-shape rule, the
   * others store it); what is stable and is asserted is that NO door answers it as an undeclared-key violation.
   */
  for (const kind of KINDS) {
    it(`strict does not judge a null value for an undeclared key as a violation (${kind})`, async () => {
      const space = spaceOf('strict');
      await fresh(space);
      const answer = await rest('POST', bodyPath(space, SEGMENT[kind]), CREATE[kind](`null-${kind}`, { [UNDECLARED]: null }));
      assert.equal(namesIt(answer.text), false, `a null value was judged as an undeclared key (${answer.status}): ${answer.text.slice(0, 300)}`);
      assert.equal(flagsKey(answer), false, `a null value was flagged: ${answer.text.slice(0, 300)}`);
    });
  }
});
