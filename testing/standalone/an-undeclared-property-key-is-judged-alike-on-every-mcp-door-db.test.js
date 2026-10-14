/**
 * A property key the record's type does not declare is judged the same way on every MCP storing door, in every
 * validation mode (`Q-93`, slice b23t-keys: the MCP tools, the `POST /api/<tool>` door and the link door).
 *
 * ## The rule (one sentence per mode)
 *
 * A type that declares AT LEAST ONE property refuses (`strict`), flags (`warn`) or ignores (`off`) a property key a
 * write ADDS that the type does not declare. In `strict` the refusal is the documented `schema_violation` body with the
 * key as an `introduced` row and nothing stored; in `warn` the record lands and the answer SHOWS the violation, in its
 * text and in its structured half; in `off` the record lands and the answer says nothing. A type that declares no
 * property (an absent `propertySchemas`, or `{}`) is OPEN and never judged.
 *
 * ## What is asserted, door by door
 *
 * Every storing tool, `save_*` and `update_*` for the four kinds, through `callTool` (the dispatch every MCP request and
 * `POST /api/<tool>` goes through); `save_bulk` per item; the REST tool door for one create and one update; and the
 * link door, which carries no properties and so must never be refused for an undeclared key. "Nothing stored" is read
 * from the store, per kind, never from the answer.
 *
 * ## What it deliberately does not pin
 *
 * The refusal's status differs by door on purpose (REST create 400, REST update 422, MCP 422) and is not compared.
 * The parity cases compare what the two doors REFUSE FOR: the `introduced` row's field and reason must be the same on
 * the REST route and the tool for the same payload. The reason wording is the validator's (fixed by the plan); the
 * `says` helper looks for that sentence in text and in structured data alike, so it does not depend on WHERE a door
 * puts a warning. (`namesTheKey` of the shared fixture cannot be used for this: the key's own spelling contains the
 * word `declared`, so any answer that echoes the stored record passes it.)
 *
 * ## Controls (green on the base; the rule itself is red there)
 *
 * `off` ignores the key, an OPEN type is silent, a key already stored on a record stays editable, and the link door never
 * refuses. Without them "refused" could be a door that refuses everything, and "silent" a door that says nothing at all.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-undeclared-property-key-is-judged-alike-on-every-mcp-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import {
  MODES, spaceOf, UNDECLARED, DECLARED, DECLARING, OPEN, EMPTY_DECLARED_ENTITY, COLLECTION,
  openUndeclaredKeyDoors, wipeAll, storedWithKey,
} from './_undeclared-key-doors.mjs';

const skip = await mongoSkipReason();

const KINDS = Object.freeze(['entity', 'fact', 'edge', 'chrono']);
const T0 = '2026-10-01T00:00:00.000Z';
/** The validator's reason for an undeclared key: fixed by the plan, so asserted verbatim. */
const reasonFor = (key = UNDECLARED) => `property '${key}' is not declared on this type`;
const FIELD = `properties.${UNDECLARED}`;
const SECOND = 'zzSecondUndeclared';

const END_A = randomUUID();
const END_B = randomUUID();
const END_C = randomUUID();
const FACT_ID = randomUUID();

let doors;
let door;
let TOOLS_BY_NAME, toolSchemasFor, materialisedSchema;

/** Does an answer — text, or any structured value — carry the undeclared-key reason for `key`? */
function says(answer, key = UNDECLARED) {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
  return text.includes(reasonFor(key));
}

/** The tool door's answer, in the shape the MCP half uses: `{ isError, body, text }` (the data is the structured half). */
const asToolAnswer = (res) => ({
  status: res.status, isError: res.body?.ok !== true, body: res.body?.data ?? {}, text: res.body?.error ?? res.body?.text ?? '',
});

// ── seeding: directly into the store, so a case does not depend on how the base or the rule treats the write ──

async function seed(space, kind, _id, extra = {}) {
  await door.coll(space, COLLECTION[kind]).insertOne(build[kind](space, _id, 1, extra));
  return _id;
}

/** A stored record whose type declares the kind's one property, holding only that property. */
function seedDeclaring(space, kind, properties = { [DECLARED[kind]]: 'ok' }) {
  const _id = randomUUID();
  const extra = kind === 'edge' ? { from: END_A, to: END_B, label: DECLARING.edge, properties }
    : { type: DECLARING[kind], properties };
  return seed(space, kind, _id, extra);
}

const storedDoc = (space, kind, _id) => door.coll(space, COLLECTION[kind]).findOne({ _id });

/** What a record write for `kind` carries: the declared key plus the undeclared one (a create has nothing stored to hold the first). */
function saveCall(kind, space, properties = { [DECLARED[kind]]: 'ok', [UNDECLARED]: 'x' }) {
  switch (kind) {
    case 'entity': return ['save_entity', { space, name: 'Saved entity', type: DECLARING.entity, properties, checkDuplicates: false }];
    case 'fact': return ['save_fact', { space, fact: 'a saved fact', type: DECLARING.fact, properties, checkDuplicates: false }];
    case 'edge': return ['save_edge', { space, from: END_A, to: END_B, label: DECLARING.edge, properties }];
    case 'chrono': return ['save_chrono', { space, title: 'Saved chrono', type: DECLARING.chrono, startsAt: T0, properties, checkDuplicates: false }];
    default: throw new Error(`no save call for ${kind}`);
  }
}
const updateCall = (kind, space, id, properties = { [UNDECLARED]: 'x' }) => [`update_${kind}`, { space, id, properties }];

/** The strict refusal's body, whichever door carried it: the `introduced` row for `key`, found by its field. */
function introducedRow(body, key = UNDECLARED) {
  return (body?.introduced ?? []).find(r => r.field === `properties.${key}`);
}

/**
 * `answer` is a strict refusal naming `key` as an `introduced` row, with the validator's reason and the type's declared
 * keys. `what` says which door, so a red run names the door that accepted it.
 */
function assertRefusedForKey(answer, kind, what, { key = UNDECLARED, value = 'x', stored = '' } = {}) {
  assert.equal(answer.isError, true,
    `${what}: a strict space ACCEPTED a write adding the undeclared key '${key}' instead of refusing it${stored}: ${String(answer.text).slice(0, 160)}`);
  assert.equal(answer.body.error, 'schema_violation', `${what}: the refusal is not the documented schema_violation body: ${JSON.stringify(answer.body).slice(0, 200)}`);
  const row = introducedRow(answer.body, key);
  assert.ok(row, `${what}: no introduced row for properties.${key}; introduced = ${JSON.stringify(answer.body.introduced)}`);
  assert.equal(row.reason, reasonFor(key), `${what}: the introduced row's reason`);
  assert.deepEqual(row.value, value, `${what}: the introduced row carries the offending value`);
  assert.ok(Array.isArray(row.declared) && row.declared.includes(DECLARED[kind]),
    `${what}: the row names the declared keys (${DECLARED[kind]}): ${JSON.stringify(row.declared)}`);
}

before(async () => {
  if (skip) return;
  doors = await openUndeclaredKeyDoors({ suite: 'undeclkeysmcp' });
  door = doors.door;
  ({ TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js'));
  ({ toolSchemasFor, materialisedSchema } = await import('../../server/dist/mcp/tool-schema.js'));
});

after(async () => {
  await doors?.close();
});

beforeEach(async () => {
  if (skip) return;
  await wipeAll(door);
  for (const mode of MODES) {
    const space = spaceOf(mode);
    // Endpoints an edge write needs (the spaces keep strict linkage), and a fact a link can hang off.
    for (const id of [END_A, END_B, END_C]) await seed(space, 'entity', id, { name: `end ${id}`, type: OPEN.entity });
    await seed(space, 'fact', FACT_ID, { type: OPEN.fact });
    await door.setCounter(space, 1000);
  }
});

// ── the single-record tools ─────────────────────────────────────────────────────────────────────────────

describe('a save tool judges an undeclared key by the space\'s mode', { skip }, () => {
  for (const kind of KINDS) {
    describe(`save_${kind}`, () => {
      it('strict refuses it as an introduced row and stores nothing', async () => {
        const space = spaceOf('strict');
        const [name, args] = saveCall(kind, space);
        const r = await doors.mcp(name, args);
        const stored = await storedWithKey(door, space, kind);
        assertRefusedForKey(r, kind, name, { stored: ` (${stored.length} stored)` });
        assert.deepEqual(stored.map(d => d._id), [], `${name} refused the write but a record carrying '${UNDECLARED}' is in the store`);
        assert.equal(r.status, 422, `${name}: the tool door answers a schema refusal 422`);
      });

      it('warn stores it and the answer shows the violation, in text and in structured data', async () => {
        const space = spaceOf('warn');
        const [name, args] = saveCall(kind, space);
        const r = await doors.mcp(name, args);
        assert.equal(r.isError, false, `${name} refused in a warn space: ${r.text}`);
        const stored = await storedWithKey(door, space, kind);
        assert.equal(stored.length, 1, `${name} in a warn space did not store the record`);
        assert.ok(says(r.text), `${name} in a warn space stored a record with an undeclared key and its TEXT shows no violation: ${r.text.slice(0, 200)}`);
        assert.ok(says(r.body), `${name} in a warn space: its structured answer shows no violation: ${JSON.stringify(r.body).slice(0, 200)}`);
      });

      it('off stores it and shows nothing (control)', async () => {
        const space = spaceOf('off');
        const [name, args] = saveCall(kind, space);
        const r = await doors.mcp(name, args);
        assert.equal(r.isError, false, `${name} refused in an off space: ${r.text}`);
        assert.equal((await storedWithKey(door, space, kind)).length, 1, `${name} in an off space did not store the record`);
        assert.ok(!says(r.text) && !says(r.body), `${name} in an off space shows an undeclared-key violation: ${r.text.slice(0, 200)}`);
      });
    });
  }
});

describe('an update tool judges an undeclared key the update ADDS by the space\'s mode', { skip }, () => {
  for (const kind of KINDS) {
    describe(`update_${kind}`, () => {
      it('strict refuses it as an introduced row and leaves the record as it was', async () => {
        const space = spaceOf('strict');
        const id = await seedDeclaring(space, kind);
        const [name, args] = updateCall(kind, space, id);
        const r = await doors.mcp(name, args);
        const after = await storedDoc(space, kind, id);
        assertRefusedForKey(r, kind, name, { stored: ` (stored properties now ${JSON.stringify(after?.properties)})` });
        assert.deepEqual(after.properties, { [DECLARED[kind]]: 'ok' }, `${name} refused the update but changed the record`);
        assert.equal(r.status, 422, `${name}: the tool door answers a schema refusal 422`);
      });

      it('warn applies it and the answer SHOWS the violation, in text and in structured data', async () => {
        const space = spaceOf('warn');
        const id = await seedDeclaring(space, kind);
        const [name, args] = updateCall(kind, space, id);
        const r = await doors.mcp(name, args);
        assert.equal(r.isError, false, `${name} refused in a warn space: ${r.text}`);
        assert.equal((await storedDoc(space, kind, id)).properties[UNDECLARED], 'x', `${name} in a warn space did not apply the update`);
        assert.ok(says(r.text), `${name} in a warn space applied an undeclared key and its TEXT shows no violation: ${r.text.slice(0, 200)}`);
        assert.ok(says(r.body), `${name} in a warn space: its structured answer shows no violation`);
      });

      it('off applies it and shows nothing (control)', async () => {
        const space = spaceOf('off');
        const id = await seedDeclaring(space, kind);
        const [name, args] = updateCall(kind, space, id);
        const r = await doors.mcp(name, args);
        assert.equal(r.isError, false, `${name} refused in an off space: ${r.text}`);
        assert.equal((await storedDoc(space, kind, id)).properties[UNDECLARED], 'x', `${name} in an off space did not apply the update`);
        assert.ok(!says(r.text) && !says(r.body), `${name} in an off space shows an undeclared-key violation: ${r.text.slice(0, 200)}`);
      });
    });
  }
});

// ── save_bulk: per item ────────────────────────────────────────────────────────────────────────────────

/** One clean item and one carrying the undeclared key, per kind; the second edge goes to END_C so its identity differs. */
function bulkBody(space) {
  const ok = (kind) => ({ [DECLARED[kind]]: 'ok' });
  const bad = (kind) => ({ [DECLARED[kind]]: 'ok', [UNDECLARED]: 'x' });
  return {
    space,
    facts: [{ fact: 'ctl', type: DECLARING.fact, properties: ok('fact') }, { fact: 'bad', type: DECLARING.fact, properties: bad('fact') }],
    entities: [{ name: 'ctl', type: DECLARING.entity, properties: ok('entity') }, { name: 'bad', type: DECLARING.entity, properties: bad('entity') }],
    chrono: [
      { title: 'ctl', type: DECLARING.chrono, startsAt: T0, properties: ok('chrono') },
      { title: 'bad', type: DECLARING.chrono, startsAt: T0, properties: bad('chrono') },
    ],
    edges: [
      { from: END_A, to: END_B, label: DECLARING.edge, properties: ok('edge') },
      { from: END_A, to: END_C, label: DECLARING.edge, properties: bad('edge') },
    ],
  };
}
/** Which item of the bulk body a stored record is: its own identifying field, one per kind. */
const BULK_MARKER = Object.freeze({
  fact: d => d.fact, entity: d => d.name, chrono: d => d.title, edge: d => (d.to === END_C ? 'bad' : 'ctl'),
});
/** The markers of the stored records that hold the kind's declared key — the items this batch wrote (the seeds hold none). */
async function bulkLanded(space, kind) {
  const docs = await door.coll(space, COLLECTION[kind]).find({ [`properties.${DECLARED[kind]}`]: { $exists: true } }).toArray();
  return docs.map(BULK_MARKER[kind]).sort();
}
/** The error rows for one item index of one kind. */
const rowsFor = (errors, type, index) => (errors ?? []).filter(e => e.type === type && e.index === index);

describe('save_bulk judges an undeclared key per item by the space\'s mode', { skip }, () => {
  it('strict refuses the item carrying it, in its own row, and writes the clean item beside it', async () => {
    const space = spaceOf('strict');
    const r = await doors.mcp('save_bulk', bulkBody(space));
    const problems = [];
    for (const kind of KINDS) {
      const bad = rowsFor(r.body.errors, kind, 1);
      if (!bad.some(e => says(e.reason))) problems.push(`${kind}: no refusal row for the item adding '${UNDECLARED}' (rows: ${JSON.stringify(bad)})`);
      if (rowsFor(r.body.errors, kind, 0).length > 0) problems.push(`${kind}: the clean item beside it has an error row`);
      const landed = await bulkLanded(space, kind);
      if (landed.join() !== 'ctl') problems.push(`${kind}: stored items are [${landed}], expected only the clean one`);
      if ((await storedWithKey(door, space, kind)).length > 0) problems.push(`${kind}: a record carrying '${UNDECLARED}' was stored`);
    }
    assert.deepEqual(problems, [], 'save_bulk in a strict space did not refuse the items that add an undeclared key');
  });

  it('warn writes both and reports the violation on the item that carries it', async () => {
    const space = spaceOf('warn');
    const r = await doors.mcp('save_bulk', bulkBody(space));
    const problems = [];
    for (const kind of KINDS) {
      if (!rowsFor(r.body.errors, kind, 1).some(e => says(e.reason))) problems.push(`${kind}: no warning row for the item adding '${UNDECLARED}'`);
      if (rowsFor(r.body.errors, kind, 0).some(e => says(e.reason))) problems.push(`${kind}: the clean item carries the warning`);
      const landed = await bulkLanded(space, kind);
      if (landed.join() !== 'bad,ctl') problems.push(`${kind}: stored items are [${landed}], expected both`);
    }
    assert.deepEqual(problems, [], 'save_bulk in a warn space did not report the undeclared key per item');
  });

  it('off writes both and reports nothing (control)', async () => {
    const space = spaceOf('off');
    const r = await doors.mcp('save_bulk', bulkBody(space));
    const problems = [];
    for (const kind of KINDS) {
      const landed = await bulkLanded(space, kind);
      if (landed.join() !== 'bad,ctl') problems.push(`${kind}: stored items are [${landed}], expected both`);
    }
    if (says(r.body.errors) || says(r.text)) problems.push(`an undeclared-key row in an off space: ${JSON.stringify(r.body.errors).slice(0, 200)}`);
    assert.deepEqual(problems, [], 'save_bulk in an off space judged an undeclared key');
  });
});

// ── the REST tool door: POST /api/<tool> ───────────────────────────────────────────────────────────────

describe('POST /api/<tool> judges an undeclared key as the tool through callTool does', { skip }, () => {
  const door422 = (what, res) => `${what}: status ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`;

  for (const verb of ['save', 'update']) {
    describe(`${verb}_entity`, () => {
      const call = async (mode) => {
        const space = spaceOf(mode);
        if (verb === 'save') {
          const [name, args] = saveCall('entity', space);
          return { space, res: await doors.rest('POST', `/api/${name}`, args) };
        }
        const id = await seedDeclaring(space, 'entity');
        const [name, args] = updateCall('entity', space, id);
        return { space, id, res: await doors.rest('POST', `/api/${name}`, args) };
      };

      it('strict answers 422 with the same refusal and stores nothing', async () => {
        const { space, id, res } = await call('strict');
        const stored = await storedWithKey(door, space, 'entity');
        assert.equal(res.status, 422, `the tool door ACCEPTED an undeclared key in a strict space (${stored.length} stored): ${door422(`${verb}_entity`, res)}`);
        assertRefusedForKey(asToolAnswer(res), 'entity', `POST /api/${verb}_entity`, { stored: ` (${stored.length} stored)` });
        assert.deepEqual(stored.map(d => d._id), [], `the refused ${verb} left a record carrying '${UNDECLARED}'`);
        if (id) assert.deepEqual((await storedDoc(space, 'entity', id)).properties, { [DECLARED.entity]: 'ok' });
      });

      it('warn answers 200 and its data SHOWS the violation', async () => {
        const { space, res } = await call('warn');
        assert.equal(res.status, 200, door422('warn', res));
        assert.equal((await storedWithKey(door, space, 'entity')).length, 1, 'the tool door did not store the record in a warn space');
        assert.ok(says(res.body.data) || says(res.body.text), `the tool door stored an undeclared key in a warn space and shows no violation: ${JSON.stringify(res.body).slice(0, 200)}`);
        assert.ok(says(res.body.data), `the structured data of the tool door's answer shows no violation (the text is a fixed sentence there): ${JSON.stringify(res.body).slice(0, 200)}`);
      });

      it('off answers 200 and shows nothing (control)', async () => {
        const { space, res } = await call('off');
        assert.equal(res.status, 200, door422('off', res));
        assert.equal((await storedWithKey(door, space, 'entity')).length, 1);
        assert.ok(!says(res.body), `the tool door shows an undeclared-key violation in an off space: ${JSON.stringify(res.body).slice(0, 200)}`);
      });
    });
  }
});

// ── parity: the REST route and the tool refuse the same payload for the same reason ────────────────────

describe('the REST route and the MCP tool refuse an undeclared key for the same reason', { skip }, () => {
  const restCreate = (kind, space) => {
    const properties = { [DECLARED[kind]]: 'ok', [UNDECLARED]: 'x' };
    const bodies = {
      entity: { name: 'Parity', type: DECLARING.entity, properties },
      fact: { fact: 'a parity fact', type: DECLARING.fact, properties },
      edge: { from: END_A, to: END_B, label: DECLARING.edge, properties },
      chrono: { title: 'Parity', type: DECLARING.chrono, startsAt: T0, properties },
    };
    return doors.rest('POST', `/api/brain/spaces/${space}/${COLLECTION[kind]}`, bodies[kind]);
  };
  const restUpdate = (kind, space, id) =>
    doors.rest('PATCH', `/api/brain/spaces/${space}/${COLLECTION[kind]}/${id}`, { properties: { [UNDECLARED]: 'x' } });

  /** The pair `{field, reason}` of the row naming the key: what two doors must agree on (not the status, not the prose around it). */
  const rowOf = (body) => {
    const row = introducedRow(body);
    return row ? { field: row.field, reason: row.reason } : undefined;
  };

  for (const kind of KINDS) {
    it(`create ${kind}: both refuse, with the same introduced row`, async () => {
      const space = spaceOf('strict');
      const rest = await restCreate(kind, space);
      await door.coll(space, COLLECTION[kind]).deleteMany({ [`properties.${UNDECLARED}`]: { $exists: true } });
      const [name, args] = saveCall(kind, space);
      const mcp = await doors.mcp(name, args);
      assert.ok(rest.status >= 400 && rest.body?.error === 'schema_violation',
        `the REST create of a ${kind} did not refuse an undeclared key in a strict space (status ${rest.status}): ${rest.text.slice(0, 160)}`);
      assert.equal(mcp.isError, true, `the ${name} tool did not refuse an undeclared key in a strict space: ${mcp.text.slice(0, 160)}`);
      assert.deepEqual(rowOf(mcp.body), rowOf(rest.body), `${kind} create: the two doors refused for different reasons`);
      assert.ok(rowOf(rest.body), `${kind} create: REST's refusal names no row for ${FIELD}: ${JSON.stringify(rest.body.introduced)}`);
    });

    it(`update ${kind}: both refuse, with the same introduced row`, async () => {
      const space = spaceOf('strict');
      const id = await seedDeclaring(space, kind);
      const rest = await restUpdate(kind, space, id);
      const mcp = await doors.mcp(...updateCall(kind, space, id));
      assert.ok(rest.status >= 400 && rest.body?.error === 'schema_violation',
        `the REST update of a ${kind} did not refuse an undeclared key in a strict space (status ${rest.status}): ${rest.text.slice(0, 160)}`);
      assert.equal(mcp.isError, true, `update_${kind} did not refuse an undeclared key in a strict space: ${mcp.text.slice(0, 160)}`);
      assert.deepEqual(rowOf(mcp.body), rowOf(rest.body), `${kind} update: the two doors refused for different reasons`);
      assert.ok(rowOf(rest.body), `${kind} update: REST's refusal names no row for ${FIELD}: ${JSON.stringify(rest.body.introduced)}`);
    });
  }
});

// ── what is NOT judged: open types ─────────────────────────────────────────────────────────────────────

describe('a type that declares no property is open: an undeclared key is never judged (control)', { skip }, () => {
  const OPEN_CASES = [
    { label: `entity type '${OPEN.entity}' (no propertySchemas)`, kind: 'entity', type: OPEN.entity },
    { label: `entity type '${EMPTY_DECLARED_ENTITY}' (propertySchemas: {})`, kind: 'entity', type: EMPTY_DECLARED_ENTITY },
    { label: `fact type '${OPEN.fact}'`, kind: 'fact', type: OPEN.fact },
    { label: `edge label '${OPEN.edge}'`, kind: 'edge', type: OPEN.edge },
    { label: `chrono type '${OPEN.chrono}'`, kind: 'chrono', type: OPEN.chrono },
  ];
  const openSave = (c, space) => {
    const properties = { [UNDECLARED]: 'x' };
    switch (c.kind) {
      case 'entity': return ['save_entity', { space, name: 'Open', type: c.type, properties, checkDuplicates: false }];
      case 'fact': return ['save_fact', { space, fact: 'an open fact', type: c.type, properties, checkDuplicates: false }];
      case 'edge': return ['save_edge', { space, from: END_A, to: END_B, label: c.type, properties }];
      default: return ['save_chrono', { space, title: 'Open', type: c.type, startsAt: T0, properties, checkDuplicates: false }];
    }
  };

  for (const c of OPEN_CASES) {
    it(`${c.label}: stored without a refusal or a warning in strict, warn and off`, async () => {
      const problems = [];
      for (const mode of MODES) {
        const space = spaceOf(mode);
        const [name, args] = openSave(c, space);
        const r = await doors.mcp(name, args);
        if (r.isError) problems.push(`${mode}: ${name} refused: ${r.text.slice(0, 120)}`);
        if (says(r.text) || says(r.body)) problems.push(`${mode}: ${name} judged the key on an open type`);
        const stored = await storedWithKey(door, space, c.kind);
        if (stored.length !== 1) problems.push(`${mode}: ${name} stored ${stored.length} record(s) carrying the key`);
      }
      assert.deepEqual(problems, [], `an open type was judged: ${c.label}`);
    });
  }

  it('the same holds when the open entity is UPDATED with a new key (update_entity)', async () => {
    const problems = [];
    for (const mode of MODES) {
      const space = spaceOf(mode);
      const id = await seed(space, 'entity', randomUUID(), { name: 'open', type: OPEN.entity, properties: {} });
      const r = await doors.mcp(...updateCall('entity', space, id));
      if (r.isError) problems.push(`${mode}: update_entity refused: ${r.text.slice(0, 120)}`);
      if (says(r.text) || says(r.body)) problems.push(`${mode}: update_entity judged the key on an open type`);
      if ((await storedDoc(space, 'entity', id)).properties[UNDECLARED] !== 'x') problems.push(`${mode}: the update was not applied`);
    }
    assert.deepEqual(problems, []);
  });
});

// ── a key already stored is the record's own, never the write's ────────────────────────────────────────

describe('update_entity leaves a key already stored on the record alone, and refuses only keys it adds', { skip }, () => {
  const space = spaceOf('strict');
  const heldKey = () => seed(space, 'entity', randomUUID(),
    { name: 'holder', type: DECLARING.entity, properties: { [DECLARED.entity]: 'up', [UNDECLARED]: 'old' } });

  it('a description update passes in strict (control)', async () => {
    const id = await heldKey();
    const r = await doors.mcp('update_entity', { space, id, description: 'new words' });
    assert.equal(r.isError, false, `a strict space refused an unrelated edit of a record holding a stored undeclared key: ${r.text}`);
    const doc = await storedDoc(space, 'entity', id);
    assert.equal(doc.description, 'new words');
    assert.equal(doc.properties[UNDECLARED], 'old');
  });

  it('changing the VALUE of the stored undeclared key passes in strict (control)', async () => {
    const id = await heldKey();
    const r = await doors.mcp('update_entity', { space, id, properties: { [UNDECLARED]: 'new' } });
    assert.equal(r.isError, false, `a strict space refused an edit of a key the record already held: ${r.text}`);
    assert.equal((await storedDoc(space, 'entity', id)).properties[UNDECLARED], 'new');
  });

  it('adding a SECOND undeclared key is refused naming only the new key', async () => {
    const id = await heldKey();
    const r = await doors.mcp('update_entity', { space, id, properties: { [SECOND]: 'x' } });
    const doc = await storedDoc(space, 'entity', id);
    assertRefusedForKey(r, 'entity', 'update_entity', { key: SECOND, stored: ` (stored properties now ${JSON.stringify(doc.properties)})` });
    assert.deepEqual(r.body.introduced.map(row => row.field), [`properties.${SECOND}`],
      'the refusal blames a key the record already held, which the write did not add');
    assert.deepEqual(doc.properties, { [DECLARED.entity]: 'up', [UNDECLARED]: 'old' }, 'the refused update changed the record');
  });

  it('touching the stored key and adding a new one in one call refuses only the new one', async () => {
    const id = await heldKey();
    const r = await doors.mcp('update_entity', { space, id, properties: { [UNDECLARED]: 'new', [SECOND]: 'x' } });
    const doc = await storedDoc(space, 'entity', id);
    assertRefusedForKey(r, 'entity', 'update_entity', { key: SECOND, stored: ` (stored properties now ${JSON.stringify(doc.properties)})` });
    assert.deepEqual(r.body.introduced.map(row => row.field), [`properties.${SECOND}`]);
    assert.equal(doc.properties[UNDECLARED], 'old', 'the refused update changed the stored key');
  });
});

describe('retyping an entity onto a type that does not declare a stored key', { skip }, () => {
  // The record is `scratch` (open: every key is allowed), so the key was never undeclared; under `service` it is, and
  // it is the retype that makes it so — an introduced violation, not a pre-existing one.
  const heldOnOpen = (space) => seed(space, 'entity', randomUUID(),
    { name: 'mover', type: OPEN.entity, properties: { [UNDECLARED]: 'old' } });
  const retype = (space, id) => doors.mcp('update_entity', { space, id, type: DECLARING.entity });

  it('strict refuses it as introduced and leaves the type as it was', async () => {
    const space = spaceOf('strict');
    const id = await heldOnOpen(space);
    const r = await retype(space, id);
    const doc = await storedDoc(space, 'entity', id);
    assertRefusedForKey(r, 'entity', 'update_entity (retype)', { value: 'old', stored: ` (the entity is now type '${doc.type}')` });
    assert.equal(doc.type, OPEN.entity, 'the refused retype changed the type');
  });

  it('warn retypes it and shows the violation', async () => {
    const space = spaceOf('warn');
    const id = await heldOnOpen(space);
    const r = await retype(space, id);
    assert.equal(r.isError, false, r.text);
    assert.equal((await storedDoc(space, 'entity', id)).type, DECLARING.entity);
    assert.ok(says(r.text) || says(r.body), `a warn-space retype that strands a key shows no violation: ${r.text.slice(0, 200)}`);
    assert.ok(says(r.text), 'the retype\'s TEXT shows no violation');
  });

  it('off retypes it and shows nothing (control)', async () => {
    const space = spaceOf('off');
    const id = await heldOnOpen(space);
    const r = await retype(space, id);
    assert.equal(r.isError, false, r.text);
    assert.equal((await storedDoc(space, 'entity', id)).type, DECLARING.entity);
    assert.ok(!says(r.text) && !says(r.body), 'an off-space retype shows a violation');
  });
});

// ── the link door ──────────────────────────────────────────────────────────────────────────────────────

describe('the link door carries no properties and never refuses for an undeclared key (control)', { skip }, () => {
  const linkArgs = (space) => ({ space, from: FACT_ID, fromKind: 'fact', to: END_A, toKind: 'entity' });
  const linkBody = () => ({ from: FACT_ID, fromKind: 'fact', to: END_A, toKind: 'entity' });
  const storedLinks = (space) => door.coll(space, 'links').find({}).toArray();
  const notASchemaRefusal = (body) => body?.error !== 'schema_violation' && body?.introduced === undefined;

  for (const mode of MODES) {
    it(`${mode}: save_link and POST /links store a link with no properties field`, async () => {
      const space = spaceOf(mode);
      const viaMcp = await doors.mcp('save_link', linkArgs(space));
      assert.equal(viaMcp.isError, false, `save_link refused in ${mode}: ${viaMcp.text}`);
      assert.ok(notASchemaRefusal(viaMcp.body));
      const viaRest = await doors.rest('POST', `/api/brain/spaces/${space}/links`, linkBody());
      assert.equal(viaRest.status, 200, `POST /links refused in ${mode}: ${viaRest.text}`);
      assert.ok(notASchemaRefusal(viaRest.body));
      const links = await storedLinks(space);
      assert.ok(links.length >= 1, 'no link was stored');
      for (const l of links) {
        assert.equal(Object.hasOwn(l, 'properties'), false, `a stored link carries a properties field: ${JSON.stringify(l)}`);
      }
    });

    it(`${mode}: a body key \`properties\` on a link is not stored and is not an undeclared-key refusal`, async () => {
      // What the base answers (measured 2026-10-14): POST /links answers 200 and ignores the key, saying so in `warnings`
      // ("unknown field — ignored"); `save_link` answers 400 "Invalid arguments ... unexpected property 'properties'" from the
      // dispatcher's `additionalProperties: false`. Neither is a schema refusal and neither stores the key — that is the part
      // asserted, because the unknown-field handling is Q-320's (D-32) to change and its answer may move.
      const space = spaceOf(mode);
      const restBody = { ...linkBody(), properties: { [UNDECLARED]: 'x' } };
      const viaRest = await doors.rest('POST', `/api/brain/spaces/${space}/links`, restBody);
      assert.ok(notASchemaRefusal(viaRest.body), `POST /links answered an undeclared-key refusal for a link: ${viaRest.text.slice(0, 200)}`);
      const viaMcp = await doors.mcp('save_link', { ...linkArgs(space), properties: { [UNDECLARED]: 'x' } });
      assert.ok(notASchemaRefusal(viaMcp.body), `save_link answered an undeclared-key refusal for a link: ${viaMcp.text.slice(0, 200)}`);
      for (const l of await storedLinks(space)) {
        assert.equal(Object.hasOwn(l, 'properties'), false, `a link stored the body's properties: ${JSON.stringify(l)}`);
        assert.ok(!JSON.stringify(l).includes(UNDECLARED), `a link stored the undeclared key: ${JSON.stringify(l)}`);
      }
    });
  }
});

// ── the schema text a caller reads while building the arguments ────────────────────────────────────────

describe('a tool\'s `properties` description states the undeclared-key rule', { skip }, () => {
  const STATES_THE_RULE = /not declared|undeclared|declares|not declare/i;
  const reach = () => MODES.map(spaceOf);
  const schemaOf = (name) => {
    const tool = TOOLS_BY_NAME.get(name);
    assert.ok(tool, `no tool named ${name} is registered — re-anchor`);
    return materialisedSchema(tool, toolSchemasFor(reach()), reach());
  };

  for (const name of ['save_entity', 'save_fact', 'save_edge', 'save_chrono']) {
    it(`${name}: the \`properties\` argument says an undeclared key is judged`, () => {
      const desc = schemaOf(name).properties?.properties?.description;
      assert.equal(typeof desc, 'string', `${name} has no \`properties\` description — re-anchor`);
      assert.match(desc, STATES_THE_RULE, `the \`properties\` description of ${name} says nothing about keys the type does not declare: "${desc}"`);
    });
  }

  for (const [array, kind] of [['facts', 'fact'], ['entities', 'entity'], ['edges', 'edge'], ['chrono', 'chrono']]) {
    it(`save_bulk: the \`properties\` of a ${kind} item says an undeclared key is judged`, () => {
      const desc = schemaOf('save_bulk').properties?.[array]?.items?.properties?.properties?.description;
      assert.equal(typeof desc, 'string', `save_bulk's ${array} item has no \`properties\` description — re-anchor`);
      assert.match(desc, STATES_THE_RULE, `the \`properties\` description of a save_bulk ${kind} item says nothing about keys the type does not declare: "${desc}"`);
    });
  }
});
