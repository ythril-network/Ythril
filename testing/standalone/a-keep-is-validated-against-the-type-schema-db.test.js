/**
 * Keeping a version is judged by the record type's schema before it is written (Q-624 design §9 step 2, "Schema").
 *
 * ## What it prevents
 *
 * A fork of any kind can hold a property the type's schema refuses: an arrival RECORDS a schema violation rather than refusing (the
 * fork is stored as a peer wrote it), so the version Review shows may be one no door here would have stored. "Keep this version" then
 * wrote it over the parent through the keep-writer, which validated nothing, in a space set to `strict`: the one path that put a value
 * on a record that the same space refuses at create and at every update (the hole `brain/write-validation.ts` describes). Slice I3 papered
 * over it with an exemption in `every-door-that-stores-a-record-reaches-a-validator`. The design's answer is a 422 with the schema's own
 * sentence, before anything is written, and the exemption goes.
 *
 * ## What it holds, per kind that forks (the set is read from the planner)
 *
 *  - keep 'fork' of a version that breaks the schema, in a strict space: refused 422 on BOTH doors, with the SAME sentence, the schema's
 *    own; the parent and the fork stay as they were (nothing written, nothing tombstoned);
 *  - keep 'fork' of a version that satisfies it: accepted (the control: the refusal is about the schema, not about the resolve);
 *  - keep 'parent' where the parent itself already breaks the schema: accepted, since the keep introduces nothing (the P-6 split: a stored
 *    violation does not freeze a record), and the fork goes.
 *
 * Run: node --test testing/standalone/a-keep-is-validated-against-the-type-schema-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, reviewDoors } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624schema';

/** The type (or, for an edge, the label) each kind's fixture row carries: the key its schema is declared under. */
const SCHEMA_KEY = { fact: 'note', entity: 'concept', chrono: 'event', edge: 'relates' };
const AGE = { propertySchemas: { age: { type: 'number' } } };
const META = {
  validationMode: 'strict',
  typeSchemas: Object.fromEntries(Object.entries(SCHEMA_KEY).map(([kind, key]) => [kind, { [key]: AGE }])),
};

/** An edge fork holds its subject's five identity fields, which the fixture's edge builder derives from the row id. */
const identityOf = (row) => (row.from === undefined ? {} : { from: row.from, to: row.to, label: row.label, fromKind: row.fromKind, toKind: row.toKind });
const typed = (kind) => (kind === 'edge' ? {} : { type: SCHEMA_KEY[kind] });

describe('keeping a version is validated against the record type\'s schema', { skip }, () => {
  let door; let doors;
  before(async () => {
    door = await openPushDoor({ suite: 'q624_keepschema', spaces: [{ id: S, label: 'Schema', folders: [], meta: META }] });
    await initForkFixtures();
    doors = await reviewDoors(door, S);
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  for (const kind of Object.keys(FORK_KINDS)) {
    const k = FORK_KINDS[kind];
    /** A parent holding `age: 41` and a fork of it holding `forkAge`; the two differ only there. */
    async function seed(parentProps, forkProps) {
      const parent = k.row(S, `p-${kind}`, 5, { ...typed(kind), properties: parentProps });
      await door.coll(S, k.family).insertOne(parent);
      const fork = await seedFork(door, S, kind, parent._id, 5, { ...identityOf(parent), ...typed(kind), properties: forkProps });
      return { parent, fork };
    }

    it(`${kind}: keep 'fork' of a version that breaks the schema is a 422 on both doors, with one sentence, and writes nothing`, async () => {
      const { parent, fork } = await seed({ age: 41 }, { age: 'forty' });
      const rest = await doors.resolve.REST(kind, fork._id, 'fork');
      const mcp = await doors.resolve.MCP(kind, fork._id, 'fork');
      assert.equal(rest.ok, false, `${kind}: REST kept a version the schema refuses`);
      assert.equal(mcp.ok, false, `${kind}: MCP kept a version the schema refuses`);
      assert.equal(rest.status, 422, `${kind}: REST answered ${rest.status}, not the schema refusal 422`);
      assert.match(rest.sentence, /age/, `${kind}: the sentence names no property: ${rest.sentence}`);
      assert.equal(mcp.sentence, rest.sentence, `${kind}: the doors word the refusal differently`);
      const stored = await door.coll(S, k.family).findOne({ _id: parent._id });
      assert.deepEqual(stored.properties, { age: 41 }, `${kind}: the refused keep wrote the parent`);
      assert.equal(stored.seq, 5, `${kind}: the refused keep restamped the parent`);
      assert.ok(await door.coll(S, k.family).findOne({ _id: fork._id }), `${kind}: the refused keep removed the fork`);
    });

    it(`${kind}: keep 'fork' of a version that satisfies the schema is accepted (the control)`, async () => {
      const { parent, fork } = await seed({ age: 41 }, { age: 42 });
      const r = await doors.resolve.MCP(kind, fork._id, 'fork');
      assert.ok(r.ok, `${kind}: a valid version was refused: ${r.sentence}`);
      assert.deepEqual((await door.coll(S, k.family).findOne({ _id: parent._id })).properties, { age: 42 });
    });

    it(`${kind}: keep 'parent' of a parent that already breaks the schema is accepted (it introduces nothing)`, async () => {
      const { parent, fork } = await seed({ age: 'forty' }, { age: 'fifty' });
      const r = await doors.resolve.MCP(kind, fork._id, 'parent');
      assert.ok(r.ok, `${kind}: keeping the stored body was refused for a violation it did not introduce: ${r.sentence}`);
      assert.deepEqual((await door.coll(S, k.family).findOne({ _id: parent._id })).properties, { age: 'forty' });
      assert.equal(await door.coll(S, k.family).findOne({ _id: fork._id }), null, `${kind}: the fork stayed`);
    });
  }
});
