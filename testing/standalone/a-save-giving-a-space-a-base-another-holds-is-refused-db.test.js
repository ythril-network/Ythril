/**
 * A write that would give a space an RDF base another space of this instance already holds with RDF on is refused `409 rdf_base_shared`
 * AT THE SAVE, on every door that stores the setting (bundle-269 slice F, finding 10's second half): the REST `PATCH /api/spaces/:id` and
 * MCP `schema_update`, and the create doors `POST /api/spaces` and MCP `save_space`. The exports keep their own refusal for a pair that
 * already exists (`two-spaces-with-one-base-are-refused-by-the-exports-db`); this one stops the pair being made.
 *
 * - Enabling by an explicit base, enabling with the default `<public url>/ld/<space>/` that another space holds by an explicit base, and a
 *   rebase onto it: each is 409 `rdf_base_shared` and stores nothing; a create with the base is refused and leaves no space behind.
 * - A different base passes; a space re-saving its own base passes; a space with RDF off holding the same stored base does not count (as
 *   the exports judge it); a pair that already exists does not refuse a write that leaves the base and the switch as they are.
 * - The other space is named only to a caller who may read its schema (the no-trace rule the exports keep).
 * - A base that STARTS another space's base, or is started by it (`<pub>/ld/` and `<pub>/ld/held/inner/` against `<pub>/ld/held/`), is refused
 *   `409 rdf_base_nested` on every door, whichever way round: `/ld/` resolves an address to the space holding the longest base that starts
 *   it, so a nested base would take every address of the space it sits in (bundle-271, Q-758, review of S3 finding 3). A sibling base passes.
 *
 * Run: node --test testing/standalone/a-save-giving-a-space-a-base-another-holds-is-refused-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-rdf-shared-');
const skip = await mongoSkipReason();

const base = (name) => `https://shared.example.org/ld/${name}/`;
const HOLDER = 'sharedbaseholder';
const SWITCHED_OFF = 'sharedbaseoff';
const TARGET = 'sharedbasetarget';
const MOVER = 'sharedbasemover';
const DEFAULTED = 'dflt';
const PAIR_A = 'sharedpaira';
const PAIR_B = 'sharedpairb';
const PUBLIC = 'https://pub.example.org/';
const CREATE_DOORS = ['space-create', 'mcp-save-space'];

const on = (b) => ({ enabled: true, base: b, vocab: `${b}vocab/`, baseEpoch: 0 });
const space = (id, rdf) => ({ id, label: id, folders: [], meta: { validationMode: 'warn', ...(rdf ? { rdf } : {}) } });

describe('a save giving a space a base another space holds is refused', { skip }, () => {
  let inst;
  let SPACE_AREAS;
  before(async () => {
    await openTestMongo('rdf_base_shared_save');
    delete process.env['PUBLIC_BASE_URL'];
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    inst = await bootSchemaInstance(dir, {
      spaces: [
        space(HOLDER, on(base('held'))),
        space(SWITCHED_OFF, { ...on(base('off')), enabled: false }),
        // A create makes a space that stays: each create door has an off holder of a base of its own, so no door meets what another one made.
        ...CREATE_DOORS.map(door => space(`${SWITCHED_OFF}-${door}`, { ...on(base(`off-${door}`)), enabled: false })),
        space(TARGET), space(MOVER, on(base('mover'))), space(DEFAULTED),
        space(PAIR_A, on(base('pair'))), space(PAIR_B, on(base('pair'))),
      ],
    });
  });
  after(async () => {
    inst?.close();
    delete process.env['PUBLIC_BASE_URL'];
    await closeTestMongo();
  });

  const rdfOf = (id) => inst.heldMeta(id).rdf;
  const said = (a) => `${a.text} ${JSON.stringify(a.body ?? null)}`;
  const spaceHeld = (id) => inst.loader.getConfig().spaces.some(s => s.id === id);
  const rowOf = (over) => Object.fromEntries(SPACE_AREAS.map(a => [a, over[a] ?? 'none']));
  /** A caller that administers `own` and holds `also` (area rungs) on other spaces: never an instance administrator. */
  const callerOf = (own, also = {}) => ({
    instanceAdmin: false,
    perSpace: { [own]: rowOf(Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin']))), ...Object.fromEntries(Object.entries(also).map(([id, r]) => [id, rowOf(r)])) },
  });

  for (const door of ['space-patch', 'mcp-schema-update']) {
    describe(door, () => {
      it('enabling with the base another space holds is 409 rdf_base_shared and stores nothing', async () => {
        inst.reset();
        const answer = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('held') } });
        assert.equal(answer.status, 409, answer.text.slice(0, 300));
        assert.match(said(answer), /rdf_base_shared/);
        assert.equal(rdfOf(TARGET), undefined, 'nothing was stored');
      });

      it('a rebase onto the base another space holds is refused and the space keeps its own', async () => {
        inst.reset();
        const answer = await inst.doors[door](MOVER, { rdf: { enabled: true, base: base('held'), rebase: true } });
        assert.equal(answer.status, 409, answer.text.slice(0, 300));
        assert.match(said(answer), /rdf_base_shared/);
        assert.deepEqual(rdfOf(MOVER), on(base('mover')), 'the base and its epoch are as they were');
      });

      it('a different base passes, and a space re-saving its own base passes', async () => {
        inst.reset();
        const fresh = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('target') } });
        assert.equal(fresh.refused, false, fresh.text.slice(0, 300));
        assert.equal(rdfOf(TARGET).base, base('target'));
        const again = await inst.doors[door](HOLDER, { rdf: { enabled: true, base: base('held') } });
        assert.equal(again.refused, false, again.text.slice(0, 300));
        const rebased = await inst.doors[door](MOVER, { rdf: { enabled: true, base: base('mover-next'), rebase: true } });
        assert.equal(rebased.refused, false, rebased.text.slice(0, 300));
        assert.equal(rdfOf(MOVER).baseEpoch, 1);
      });

      it('a base that starts the base of another space, or is started by it, is 409 rdf_base_nested and stores nothing', async () => {
        inst.reset();
        const inside = await inst.doors[door](TARGET, { rdf: { enabled: true, base: `${base('held')}inner/` } });
        assert.equal(inside.status, 409, inside.text.slice(0, 300));
        assert.match(said(inside), /rdf_base_nested/, 'a base inside the base of another space has its own code');
        assert.doesNotMatch(said(inside), /rdf_base_shared/);
        assert.match(said(inside), new RegExp(HOLDER), 'an administrator is told which space it overlaps');
        assert.equal(rdfOf(TARGET), undefined, 'nothing was stored');
        inst.reset();
        const around = await inst.doors[door](TARGET, { rdf: { enabled: true, base: 'https://shared.example.org/ld/' } });
        assert.equal(around.status, 409, around.text.slice(0, 300));
        assert.match(said(around), /rdf_base_nested/, 'a base that starts the base of another space');
        assert.equal(rdfOf(TARGET), undefined, 'nothing was stored');
        inst.reset();
        const moved = await inst.doors[door](MOVER, { rdf: { enabled: true, base: `${base('held')}x/`, rebase: true } });
        assert.equal(moved.status, 409, moved.text.slice(0, 300));
        assert.match(said(moved), /rdf_base_nested/);
        assert.deepEqual(rdfOf(MOVER), on(base('mover')), 'the base and its epoch are as they were');
        inst.reset();
        const untold = await inst.doors[door](TARGET, { rdf: { enabled: true, base: `${base('held')}inner/` } }, callerOf(TARGET));
        assert.equal(untold.status, 409, untold.text.slice(0, 300));
        assert.match(said(untold), /rdf_base_nested/);
        assert.doesNotMatch(said(untold), new RegExp(HOLDER), 'a space the caller cannot read leaves no trace');
        inst.reset();
        const sibling = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('held-two') } });
        assert.equal(sibling.refused, false, `a base beside another's, neither starting the other, passes: ${sibling.text.slice(0, 300)}`);
      });

      it('a space with RDF off holding the same stored base does not count, either way round', async () => {
        inst.reset();
        const taking = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('off') } });
        assert.equal(taking.refused, false, taking.text.slice(0, 300));
        inst.reset();
        const off = await inst.doors[door](TARGET, { rdf: { enabled: false, base: base('held') } });
        assert.equal(off.refused, false, `a space that switches RDF off holds no address: ${off.text.slice(0, 300)}`);
        assert.deepEqual(rdfOf(TARGET), { enabled: false, base: base('held'), vocab: `${base('held')}vocab/`, baseEpoch: 0 });
      });

      it('the default base can collide only through an explicit one, and then it is refused', async () => {
        inst.reset();
        process.env['PUBLIC_BASE_URL'] = PUBLIC;
        try {
          const free = await inst.doors[door](DEFAULTED, { rdf: { enabled: true } });
          assert.equal(free.refused, false, free.text.slice(0, 300));
          assert.equal(rdfOf(DEFAULTED).base, `${PUBLIC}ld/${DEFAULTED}/`);
          inst.reset();
          // Another space holds the default base of DEFAULTED by an explicit one: enabling DEFAULTED with no base takes it, and is refused.
          inst.loader.getConfig().spaces.find(s => s.id === HOLDER).meta.rdf = on(`${PUBLIC}ld/${DEFAULTED}/`);
          const clash = await inst.doors[door](DEFAULTED, { rdf: { enabled: true } });
          assert.equal(clash.status, 409, clash.text.slice(0, 300));
          assert.match(said(clash), /rdf_base_shared/);
          assert.equal(rdfOf(DEFAULTED), undefined, 'nothing was stored');
        } finally { delete process.env['PUBLIC_BASE_URL']; }
      });

      it('a pair that already exists does not refuse a write that leaves the base and the switch as they are', async () => {
        inst.reset();
        const answer = await inst.doors[door](PAIR_A, { rdf: { enabled: true } });
        assert.equal(answer.refused, false, `the exports refuse the pair; this write moves nothing: ${answer.text.slice(0, 300)}`);
        assert.equal(rdfOf(PAIR_A).base, base('pair'));
      });

      it('the other space is named only to a caller who may read its schema', async () => {
        inst.reset();
        const told = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('held') } });
        assert.match(said(told), new RegExp(HOLDER), 'an administrator is told who holds it');
        const untold = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('held') } }, callerOf(TARGET));
        assert.equal(untold.status, 409, untold.text.slice(0, 300));
        assert.match(said(untold), /rdf_base_shared/);
        assert.doesNotMatch(said(untold), new RegExp(HOLDER), 'a space the caller cannot read leaves no trace');
        const reads = await inst.doors[door](TARGET, { rdf: { enabled: true, base: base('held') } }, callerOf(TARGET, { [HOLDER]: { schema: 'read' } }));
        assert.equal(reads.status, 409);
        assert.match(said(reads), new RegExp(HOLDER), 'a caller with schema: read on it is told');
      });
    });
  }

  for (const door of CREATE_DOORS) {
    describe(door, () => {
      // The created id is `<anchor>-new`: one anchor per row, so no row meets a space an earlier row made.
      it('a create with the base another space holds is 409 rdf_base_shared and leaves no space behind', async () => {
        inst.reset();
        const anchor = `${door}-refused`;
        const answer = await inst.doors[door](anchor, { rdf: { enabled: true, base: base('held') } });
        assert.equal(answer.status, 409, answer.text.slice(0, 300));
        assert.match(said(answer), /rdf_base_shared/);
        assert.equal(spaceHeld(`${anchor}-new`), false, 'no space was made');
      });

      it('a create with a base nested in the base of another space is 409 rdf_base_nested and leaves no space behind', async () => {
        inst.reset();
        const anchor = `${door}-nested`;
        const answer = await inst.doors[door](anchor, { rdf: { enabled: true, base: `${base('held')}inner/` } });
        assert.equal(answer.status, 409, answer.text.slice(0, 300));
        assert.match(said(answer), /rdf_base_nested/);
        assert.equal(spaceHeld(`${anchor}-new`), false, 'no space was made');
      });

      it('a create with a base of its own passes', async () => {
        inst.reset();
        const anchor = `${door}-free`;
        const answer = await inst.doors[door](anchor, { rdf: { enabled: true, base: base(anchor) } });
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
        assert.equal(inst.heldMeta(`${anchor}-new`).rdf?.base, base(anchor));
      });

      it('a create with the default base that another space holds by an explicit one is refused', async () => {
        inst.reset();
        process.env['PUBLIC_BASE_URL'] = PUBLIC;
        try {
          const anchor = `${door}-dflt`;
          inst.loader.getConfig().spaces.find(s => s.id === HOLDER).meta.rdf = on(`${PUBLIC}ld/${anchor}-new/`);
          const answer = await inst.doors[door](anchor, { rdf: { enabled: true } });
          assert.equal(answer.status, 409, answer.text.slice(0, 300));
          assert.match(said(answer), /rdf_base_shared/);
          assert.equal(spaceHeld(`${anchor}-new`), false);
        } finally { delete process.env['PUBLIC_BASE_URL']; }
      });

      it('a create switched off, or with the base of a space that has RDF off, passes', async () => {
        inst.reset();
        const a = await inst.doors[door](`${door}-off`, { rdf: { enabled: false, base: base('held') } });
        assert.equal(a.refused, false, a.text.slice(0, 300));
        const b = await inst.doors[door](`${door}-offbase`, { rdf: { enabled: true, base: base(`off-${door}`) } });
        assert.equal(b.refused, false, b.text.slice(0, 300));
      });

      it('the other space is named only to a caller who may read its schema', async () => {
        inst.reset();
        const creator = { instanceAdmin: false, createSpaces: true, perSpace: {} };
        const told = await inst.doors[door](`${door}-told`, { rdf: { enabled: true, base: base('held') } });
        assert.match(said(told), new RegExp(HOLDER));
        const untold = await inst.doors[door](`${door}-untold`, { rdf: { enabled: true, base: base('held') } }, creator);
        assert.equal(untold.status, 409, untold.text.slice(0, 300));
        assert.doesNotMatch(said(untold), new RegExp(HOLDER), 'a space the caller cannot read leaves no trace');
      });
    });
  }
});
