/**
 * The extractor's own property keys are the ONE exemption from the undeclared-key rule (Q-93), and it belongs to the
 * extractor alone: no REST or MCP caller can claim it.
 *
 * ## What the rule does, and why an exemption has to exist
 *
 * A type that declares at least one property is CLOSED: in a strict space a write that adds a key the type does not
 * declare is refused. The extractor writes a fixed set of keys of its own onto the records it produces, and the shipped
 * `conversation` group declares them today (`aliases`, `since`, `until`, `speaker`, `statedOn`, `attributed`) — but a
 * space owner may edit those types, narrow them, or declare something else, and an `ingest` into such a space must not
 * start failing on request 340 of a conversation because the extractor's own vocabulary became "undeclared". So the keys
 * the instance itself writes are exempt, passed to the validator as a function argument (INSTANCE_WRITTEN_PROPERTY_KEYS,
 * per kind) and never as anything a body can carry.
 *
 * ## The three halves, and which one is red on the base
 *
 * 1. **The extractor's write succeeds in a strict space that does not declare its keys, with every key stored.** The
 *    base has no rule, so this is GREEN there; it stays as the guard of the exemption and goes red only if the
 *    implementation closes the types without the exemption. Driven on three paths that all end in `writeExtraction`'s
 *    real batch door (`bulkWrite`): the function itself, the REST `POST …/ingest` route and the MCP `ingest` tool (the
 *    `extraction` body runs no model: it is validated and written, so the doors run offline).
 * 2. **The same keys sent by a normal caller are refused.** REST create, REST bulk, MCP `save_*` and MCP `save_bulk`
 *    each carry one of the extractor's keys into the same strict space: refused, nothing stored, the answer names the
 *    key. RED on the base, which stores them. This is the half that stops the exemption leaking through a door.
 * 3. **A key the extractor does NOT own is not exempt even inside an extraction.** The extraction format carries a free
 *    `properties` object on an entity and on an edge, so an extraction may name a key nobody owns; the pre-write check
 *    (`validateExtraction`, which "calls the same validator") and the write both refuse it. RED on the base.
 *
 * ## What is not covered, and why
 *
 * The extractor writes NO property on a chrono entry (`write-extraction.ts` sends title, type, startsAt, status, endsAt
 * and links only), so chrono is not in the exemption table below; a key written to chrono by a caller is the ordinary
 * rule and is another file's. The `ingest` doors are driven with an `extraction` body, not `sessions`: a raw conversation
 * runs minutes of model calls and a doc-nlp sidecar, none of which can run offline, and the write step both bodies end
 * in (`writeExtraction`) is the same function.
 *
 * ## Fixture is literal on purpose
 *
 * `EXTRACTOR_KEYS` states what the extractor writes TODAY. The companion gate
 * (`no-rest-or-mcp-door-can-pass-the-instance-written-keys-exemption.test.js`) holds the same table to the extractor's
 * sources, so it cannot go stale silently.
 *
 * Run: `node --test testing/standalone/an-extraction-writes-the-keys-it-owns-into-a-strict-space-db.test.js`
 * (requires a prior `npm run build` in server/ and a reachable test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openUndeclaredKeyDoors, storedAll, storedWithKey, namesTheKey } from './_undeclared-key-doors.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

/** The strict space under test: the shipped `conversation` types, each closed by a property the extractor does not write. */
const SPACE = 'undeclkeysxconv';
/** The one property every type declares, so the type is closed (it declares something) without declaring the extractor's keys. */
const OTHER = 'otherProp';
/** What the extractor writes onto each kind today. Literal (see above). Chrono: nothing. */
const EXTRACTOR_KEYS = Object.freeze({
  entity: ['aliases'],
  edge: ['since', 'until'],
  fact: ['speaker', 'statedOn', 'attributed'],
});
/** A key no extractor writes and no type declares. */
const FOREIGN = 'zzForeignKey';

const SCHEMA_DIR = path.join('server', 'src', 'extractor', 'conversation', 'schemas');

/** The shipped conversation group, closed by `OTHER` instead of by the extractor's keys. */
function conversationMeta() {
  const typeSchemas = {};
  for (const f of fs.readdirSync(SCHEMA_DIR).filter(n => n.endsWith('.json')).sort()) {
    const e = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
    (typeSchemas[e.knowledgeType] ??= {})[e.typeName] = { ...e.schema, propertySchemas: { [OTHER]: { type: 'string' } } };
  }
  return { validationMode: 'strict', suppressEmbeddings: true, typeSchemas };
}
const META = conversationMeta();
/** The same schema in a warn and an off space: the ingest door's other two modes. */
const MODE_SPACES = Object.freeze({ warn: 'undeclkeysxconvwarn', off: 'undeclkeysxconvoff' });
const schemaEntries = Object.entries(META.typeSchemas).flatMap(([knowledgeType, types]) =>
  Object.entries(types).map(([typeName, schema]) => ({ knowledgeType, typeName, schema })));
const CLAIM_TYPE = 'utterance';

/** An extraction every owned key appears in, valid against `schemaEntries`. */
function extraction(conversationId, { entityProps, edgeProps } = {}) {
  return {
    conversationId,
    sessions: [
      { date: '2023-05-10', turns: ['s1:1', 's1:2', 's1:3'] },
      { date: '2023-06-01', turns: ['s2:1'] },
    ],
    entities: [
      { key: 'ada', type: 'person', name: 'Ada', description: 'Ada adopted Luna.', properties: entityProps ?? { aliases: 'Adelaide; A.' }, sourceTurns: ['s1:1'] },
      { key: 'luna', type: 'animal', name: 'Luna', description: 'Luna is a cat.', properties: { aliases: 'the cat' } },
    ],
    edges: [{ label: 'owns', from: 'ada', to: 'luna', properties: edgeProps ?? { since: '2023-05-09', until: '2024-01-01' } }],
    chrono: [{ key: 'adoption', type: 'event', title: 'Ada adopted Luna', date: '2023-05-09', status: 'completed', entities: ['ada', 'luna'], sourceTurns: ['s1:1'] }],
    claims: [
      { key: 'c1', text: 'Luna lives with Ada.', speaker: 'Ada', statedOn: '2023-05-10', entities: ['luna', 'ada'], chrono: ['adoption'], sourceTurns: ['s1:1', 's1:2'] },
      { key: 'c2', text: 'Luna is a therapy cat now.', speaker: 'Ada', statedOn: '2023-06-01', entities: ['luna'], sourceTurns: ['s2:1'] },
      { key: 'c3', text: 'Luna is a common cat name.', speaker: 'assistant', statedOn: '2023-05-10', attributed: true, entities: ['luna'], sourceTurns: ['s1:3'] },
    ],
    producedBy: { extractor: 'ythril-conversation', unattended: true, backends: ['jev'] },
  };
}

let doors, writeExtraction, validateExtraction;

before(async () => {
  if (skip) return;
  doors = await openUndeclaredKeyDoors({
    suite: 'undeclkeysextract',
    extraSpaces: [
      { id: SPACE, label: SPACE, folders: [], completeLinkage: false, meta: META },
      ...Object.entries(MODE_SPACES).map(([mode, id]) => ({ id, label: id, folders: [], completeLinkage: false, meta: { ...structuredClone(META), validationMode: mode } })),
    ],
  });
  ({ writeExtraction } = await import('../../server/dist/extractor/conversation/write-extraction.js'));
  ({ validateExtraction } = await import('../../server/dist/extractor/validate-extraction.js'));
});
after(async () => { await doors?.close(); });
beforeEach(async () => { if (!skip) for (const s of [SPACE, ...Object.values(MODE_SPACES)]) await doors.door.wipe(s); });

const door = () => doors.door;
const BULK = Object.freeze({ entity: 'entities', fact: 'facts', edge: 'edges' });
/** Every record of `kind` in the strict space carrying `key`, read from the store. */
const withKey = (kind, key) => storedWithKey(door(), SPACE, kind, key);
const allOf = (kind) => storedAll(door(), SPACE, kind);
const write = (x) => writeExtraction(SPACE, x, { schemaEntries, claimType: CLAIM_TYPE, transcripts: false });

/** The run's final state, polled from the door's own status read until it ends. */
async function finishedRun(read, runId) {
  let last;
  return waitForValue(async () => {
    last = await read(runId);
    return last && ['done', 'failed'].includes(last.phase) ? last : undefined;
  }, 30_000, 100, () => `last run state: ${JSON.stringify(last)}`, { what: `ingest run ${runId} to end` });
}
const restRun = (runId) => doors.rest('GET', `/api/brain/spaces/${SPACE}/ingest/${runId}`).then(r => r.body);
const mcpRun = (runId) => doors.mcp('ingest_status', { space: SPACE, runId }).then(r => r.body);

/** Ids of the stored records, so "stored with the key" is an identity check against what the run minted. */
const storedById = async (kind) => new Map((await allOf(kind)).map(d => [String(d._id), d]));

describe('the fixture itself: the strict space is closed and does not declare what the extractor writes', { skip }, () => {
  it('every type the extraction uses declares something, and none of the extractor\'s keys', () => {
    const used = { entity: ['person', 'animal'], edge: ['owns'], fact: [CLAIM_TYPE], chrono: ['event'] };
    for (const [kind, types] of Object.entries(used)) {
      for (const t of types) {
        const declared = Object.keys(META.typeSchemas[kind][t].propertySchemas);
        assert.deepEqual(declared, [OTHER], `${kind}/${t} must declare exactly the other property, so it is closed`);
        for (const k of EXTRACTOR_KEYS[kind] ?? []) assert.ok(!declared.includes(k), `${kind}/${t} must not declare ${k}`);
      }
    }
  });

  it('the extraction is one validateExtraction accepts (so a later refusal is the rule, not a malformed fixture)', () => {
    const problems = validateExtraction(extraction('conv-fixture'), schemaEntries).filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems, []);
  });
});

describe('the extractor writes the keys it owns into a strict space that does not declare them (control, green on the base)', { skip }, () => {
  /** Assert every owned key is on its stored record, by identity: the ids the write reported, read back from the store. */
  async function assertOwnedKeysStored(ids) {
    const entities = await storedById('entity'), edges = await allOf('edge'), facts = await storedById('fact');
    assert.equal(entities.get(ids['ada'])?.properties?.aliases, 'Adelaide; A.', 'entity ada: aliases not stored');
    assert.equal(entities.get(ids['luna'])?.properties?.aliases, 'the cat', 'entity luna: aliases not stored');
    const owns = edges.find(e => e.from === ids['ada'] && e.to === ids['luna'] && e.label === 'owns');
    assert.ok(owns, 'the owns edge was not stored');
    assert.equal(owns.properties?.since, '2023-05-09', 'edge: since not stored');
    assert.equal(owns.properties?.until, '2024-01-01', 'edge: until not stored');
    const c1 = facts.get(ids['c1']), c3 = facts.get(ids['c3']);
    assert.deepEqual({ speaker: c1?.properties?.speaker, statedOn: c1?.properties?.statedOn }, { speaker: 'Ada', statedOn: '2023-05-10' }, 'fact c1: speaker/statedOn not stored');
    assert.deepEqual({ speaker: c3?.properties?.speaker, attributed: c3?.properties?.attributed }, { speaker: 'assistant', attributed: true }, 'fact c3: speaker/attributed not stored');
  }

  it('writeExtraction through the real batch door: nothing refused, every owned key stored', async () => {
    const out = await write(extraction('conv-direct'));
    assert.deepEqual(out.errors, [], 'the extractor\'s own write was refused');
    assert.deepEqual(out.written, { entities: 2, claims: 3, chrono: 1, edges: 1, transcripts: 0 });
    await assertOwnedKeysStored(out.ids);
  });

  it('REST POST …/ingest with an extraction: the run is done, nothing refused, every owned key stored', async () => {
    const start = await doors.rest('POST', `/api/brain/spaces/${SPACE}/ingest`, { kind: 'conversation', extraction: extraction('conv-rest') });
    assert.equal(start.status, 202, start.text);
    const run = await finishedRun(restRun, start.body.runId);
    assert.equal(run.phase, 'done', run.error ?? JSON.stringify(run.writeErrors));
    assert.deepEqual(run.writeErrors, [], 'the ingest run reported refused records');
    await assertOwnedKeysStored(run.ids);
  });

  it('the MCP ingest tool with an extraction: the run is done, nothing refused, every owned key stored', async () => {
    const start = await doors.mcp('ingest', { space: SPACE, kind: 'conversation', extraction: extraction('conv-mcp') });
    assert.equal(start.isError, false, start.text);
    const run = await finishedRun(mcpRun, /runId: ([\w-]+)/.exec(start.text)?.[1]);
    assert.equal(run.phase, 'done', run.error ?? JSON.stringify(run.writeErrors));
    assert.deepEqual(run.writeErrors, [], 'the ingest run reported refused records');
    await assertOwnedKeysStored(run.ids);
  });
});

/**
 * One request per (door, kind, key): the extractor's key sent by a CALLER. `anchors` says the case needs two stored entities
 * (an edge's ends), and `send(ids)` returns the door's answer.
 */
function callerCases() {
  const cases = [];
  const itemFor = {
    entity: (k, v) => ({ name: `Caller ${k}`, type: 'person', properties: { [k]: v } }),
    fact: (k, v) => ({ fact: `A caller states ${k}`, type: CLAIM_TYPE, properties: { [k]: v } }),
    edge: (k, v, ids) => ({ from: ids.a, to: ids.b, label: 'owns', properties: { [k]: v } }),
  };
  const value = { aliases: 'x', since: '2023-05-09', until: '2024-01-01', speaker: 'Ada', statedOn: '2023-05-10', attributed: true };
  const mcpSingle = { entity: 'save_entity', fact: 'save_fact', edge: 'save_edge' };
  const restSingle = { entity: 'entities', fact: 'facts', edge: 'edges' };
  for (const [kind, keys] of Object.entries(EXTRACTOR_KEYS)) {
    for (const key of keys) {
      const item = (ids) => itemFor[kind](key, value[key], ids);
      cases.push({ door: 'REST create', kind, key, anchors: kind === 'edge',
        send: (ids) => doors.rest('POST', `/api/brain/spaces/${SPACE}/${restSingle[kind]}`, item(ids)) });
      cases.push({ door: 'REST bulk', kind, key, anchors: kind === 'edge',
        send: (ids) => doors.rest('POST', `/api/brain/spaces/${SPACE}/bulk`, { [BULK[kind]]: [item(ids)] }) });
      cases.push({ door: `MCP ${mcpSingle[kind]}`, kind, key, anchors: kind === 'edge',
        send: (ids) => doors.mcp(mcpSingle[kind], { space: SPACE, ...item(ids), ...(kind === 'entity' ? { checkDuplicates: false } : {}) }) });
      cases.push({ door: 'MCP save_bulk', kind, key, anchors: kind === 'edge',
        send: (ids) => doors.mcp('save_bulk', { space: SPACE, [BULK[kind]]: [item(ids)] }) });
    }
  }
  return cases;
}

/** Whether a door's answer refused the write: a 4xx, a tool error, or a per-item error row (bulk answers 207 with `errors`). */
const refusedBy = (r) => r.status >= 400 || r.isError === true || (Array.isArray(r.body?.errors) && r.body.errors.length > 0);

describe('the exemption is the extractor\'s alone: a caller sending the extractor\'s key is refused (RED on the base)', { skip }, () => {
  /** Two stored entities a caller's edge can join, written with no extractor key so they cannot disturb the checks. */
  async function anchors() {
    const a = await doors.rest('POST', `/api/brain/spaces/${SPACE}/entities`, { name: 'Anchor Ada', type: 'person' });
    const b = await doors.rest('POST', `/api/brain/spaces/${SPACE}/entities`, { name: 'Anchor Luna', type: 'animal' });
    const idOf = (r) => r.body?.id ?? r.body?._id ?? r.body?.entity?.id;
    assert.ok(a.status < 300 && b.status < 300, `anchor entities were not created: ${a.text} ${b.text}`);
    return { a: idOf(a), b: idOf(b) };
  }

  it('derives a case for every key of every kind on every door', () => {
    const cases = callerCases();
    assert.equal(new Set(cases.map(c => `${c.door}/${c.kind}/${c.key}`)).size, cases.length, 'duplicate cases');
    for (const [kind, keys] of Object.entries(EXTRACTOR_KEYS)) {
      for (const key of keys) assert.ok(cases.filter(c => c.kind === kind && c.key === key).length >= 4, `${kind}.${key} lacks a door`);
    }
  });

  for (const c of callerCases()) {
    it(`${c.door}: ${c.kind} property '${c.key}' is refused, names the key, and nothing is stored`, async () => {
      const ids = c.anchors ? await anchors() : undefined;
      const r = await c.send(ids);
      const stored = (await withKey(c.kind, c.key)).map(d => String(d._id));
      assert.deepEqual({ refused: refusedBy(r), storedWithTheKey: stored }, { refused: true, storedWithTheKey: [] },
        `strict space: ${c.door} accepted the extractor's key '${c.key}' from a caller (status ${r.status}): ${r.text.slice(0, 300)}`);
      assert.ok(namesTheKey(r.text, c.key), `the refusal does not name '${c.key}' as undeclared: ${r.text.slice(0, 300)}`);
    });
  }
});

describe('a key the extractor does not own is not exempt, even inside an extraction (RED on the base)', { skip }, () => {
  const foreignOnEntity = () => extraction('conv-foreign-e', { entityProps: { aliases: 'Adelaide; A.', [FOREIGN]: 'x' } });
  const foreignOnEdge = () => extraction('conv-foreign-g', { edgeProps: { since: '2023-05-09', [FOREIGN]: 'x' } });

  it('control: the same extraction without the foreign key has no problem naming a key', () => {
    const problems = validateExtraction(extraction('conv-ok'), schemaEntries).filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems, []);
  });

  for (const [what, make, kind] of [['an entity\'s properties', foreignOnEntity, 'entity'], ['an edge\'s properties', foreignOnEdge, 'edge']]) {
    it(`validateExtraction refuses a foreign key on ${what}, naming it`, () => {
      const problems = validateExtraction(make(), schemaEntries).filter(p => !/producedBy/.test(p));
      assert.ok(problems.some(p => namesTheKey(p, FOREIGN)),
        `validateExtraction accepted '${FOREIGN}', an undeclared key the extractor does not own; problems: ${JSON.stringify(problems)}`);
    });

    it(`writeExtraction never stores a foreign key on ${what}`, async () => {
      let threw, out;
      try { out = await write(make()); } catch (e) { threw = e; }
      // The pre-write check throws; a writer that went on to the door would report the item in `errors`. Either is a refusal.
      const answer = threw ? threw.message : JSON.stringify(out?.errors ?? []);
      const stored = (await withKey(kind, FOREIGN)).map(d => String(d._id));
      assert.deepEqual({ refused: Boolean(threw) || (out?.errors ?? []).length > 0, storedWithTheKey: stored }, { refused: true, storedWithTheKey: [] },
        `the strict space stored an extraction's foreign key '${FOREIGN}' (the extractor does not own it): ${answer.slice(0, 300)}`);
      assert.ok(namesTheKey(answer, FOREIGN), `the refusal does not name '${FOREIGN}': ${answer.slice(0, 300)}`);
    });

    for (const [door, start, read] of [
      ['REST', async (x) => (await doors.rest('POST', `/api/brain/spaces/${SPACE}/ingest`, { kind: 'conversation', extraction: x })).body.runId, restRun],
      ['MCP', async (x) => /runId: ([\w-]+)/.exec((await doors.mcp('ingest', { space: SPACE, kind: 'conversation', extraction: x })).text)?.[1], mcpRun],
    ]) {
      it(`${door} ingest of an extraction with a foreign key on ${what}: the run does not store it`, async () => {
        const run = await finishedRun(read, await start(make()));
        const stored = (await withKey(kind, FOREIGN)).map(d => String(d._id));
        const answer = `${run.error ?? ''} ${JSON.stringify(run.writeErrors ?? [])}`;
        assert.deepEqual({ door, refused: run.phase === 'failed' || (run.writeErrors ?? []).length > 0, storedWithTheKey: stored },
          { door, refused: true, storedWithTheKey: [] },
          `${door} ingest stored an extraction's foreign key '${FOREIGN}' (run ${run.phase}): ${answer.slice(0, 300)}`);
        assert.ok(namesTheKey(answer, FOREIGN), `${door} ingest: the run does not name '${FOREIGN}': ${answer.slice(0, 300)}`);
      });
    }
  }
});

/*
 * The ingest door in its other two modes: warn stores the foreign key and the run SAYS so; off stores it and says nothing.
 * The run's answer (`error` and `writeErrors`) is what both doors report, polled from each door's own status read.
 */
describe('the ingest door in warn and off: the foreign key lands, flagged in warn and ignored in off', { skip }, () => {
  const restRunIn = (space) => (runId) => doors.rest('GET', `/api/brain/spaces/${space}/ingest/${runId}`).then(r => r.body);
  const mcpRunIn = (space) => (runId) => doors.mcp('ingest_status', { space, runId }).then(r => r.body);
  const DOORS = [
    ['REST', async (space, x) => (await doors.rest('POST', `/api/brain/spaces/${space}/ingest`, { kind: 'conversation', extraction: x })).body.runId, restRunIn],
    ['MCP', async (space, x) => /runId: ([\w-]+)/.exec((await doors.mcp('ingest', { space, kind: 'conversation', extraction: x })).text)?.[1], mcpRunIn],
  ];
  for (const [door, start, readIn] of DOORS) {
    for (const mode of ['warn', 'off']) {
      it(`${door} ingest into a ${mode} space: the entity's foreign key is stored${mode === 'warn' ? ' and the run names it as undeclared' : ' and nothing names it'}`, async () => {
        const space = MODE_SPACES[mode];
        const run = await finishedRun(readIn(space), await start(space, extraction(`conv-${mode}-${door}`, { entityProps: { aliases: 'Adelaide; A.', [FOREIGN]: 'x' } })));
        assert.equal(run.phase, 'done', `${door} ingest into a ${mode} space did not finish: ${run.error ?? JSON.stringify(run.writeErrors)}`);
        const stored = await storedWithKey(doors.door, space, 'entity', FOREIGN);
        assert.equal(stored.length, 1, `${door} ingest into a ${mode} space did not store the entity carrying '${FOREIGN}'`);
        const answer = `${run.error ?? ''} ${JSON.stringify(run.writeErrors ?? [])}`;
        if (mode === 'warn') {
          assert.ok(namesTheKey(answer, FOREIGN), `${door} ingest stored an undeclared key in a warn space and its run says nothing about it: ${answer.slice(0, 300)}`);
        } else {
          assert.ok(!answer.includes(FOREIGN), `${door} ingest into an off space names '${FOREIGN}': ${answer.slice(0, 300)}`);
        }
      });
    }
  }
});
