/**
 * A write whose INLINE `edges` are refused writes NOTHING, on every door that takes them — and answers the way the
 * record's own refusal answers (bundle-96, Q-170).
 *
 * ## The rule
 *
 * `edges` on a record write say "this record, and these labelled relationships, in one call". A relationship needs both
 * ends, so a single-record door writes the record FIRST and the edges after — which meant an edge the schema refuses (an
 * undeclared label, a subject of the wrong type, a second `functional` edge, a far end that does not exist) was refused
 * with the record already stored: the caller was told `500` (REST) or a plain `400` (MCP) and left holding a row they did
 * not ask for, and a retry stored a second one. Bulk reported the item as failed and stored it anyway.
 *
 * The rule is therefore about the whole set of doors, and about three things on each: **nothing is stored** (no record,
 * no edge — the pair "one valid edge, one refused edge" stores neither), **the refusal is the record's own** (the status
 * and body shape this door gives for the record's own schema refusal, computed per door by `ownRefusal`, never written
 * down), and **it is never a 500**.
 *
 * ## The doors are derived
 *
 * `_inline-edge-doors.mjs` reads them out of the MCP tool registry and the mounted REST routes, floors the count, and
 * refuses to run when the two surfaces disagree about which doors exist. REST goes through the whole app over HTTP and
 * MCP through `callTool`; bulk is walked on both. A case below is a loop over `DOORS`, so a door added next year is held
 * to every rule here the day it is registered.
 *
 * ## What the cases are about
 *
 * - **label / endpoint / functional**: the three schema rules an inline edge can break that need the SUBJECT — its type
 *   (`endpoints.from`) and its sibling edges (`functional`, including a second edge in the SAME body).
 * - **a far end that is missing** on a strict space, for every `toKind` (entity, fact, chrono, file), and the same edge
 *   STORED on a lax space (`strictLinkage: false` is a deliberate choice to accept dangling references).
 * - **a valid far end of every kind** is stored, not a `500` — existence has to be looked up per kind.
 * - **shape**: a whitespace-only label and a malformed `to` are refused on the MCP doors and REST PATCH as REST POST
 *   refuses them.
 * - **a create door that converges** (a caller `id` naming a stored record) leaves that record unchanged when its edge is
 *   refused; an update door leaves its record unchanged.
 * - **the controls that keep the refusal honest**: re-sending a stored functional edge is accepted (an edge is not its own
 *   duplicate); `validationMode: warn` writes record and edge; an update of an id nothing is stored under is `404`, not
 *   the edge's refusal.
 *
 * Assertions are on identities (the ids found, the edges' `from/to/label`), never on a count alone: a count of `0` passes
 * a lookup that looked in the wrong place.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-inline-edge-refused-writes-nothing-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import {
  openInlineEdgeDoors, inlineEdgeDoors, seedInlineEdgeSpace, ownRefusal, refusalDifferences,
  KINDS, LABELS, FAR_ENDS, IDS, EDITED_DESCRIPTION, edge,
} from './_inline-edge-doors.mjs';

const skip = await mongoSkipReason();

const STRICT = 'ie-strict';
const LAX = 'ie-lax';
const WARN = 'ie-warn';
/** A proxy over a strict and a warn-only member (different edge rules), and a proxy whose only member is that proxy. */
const PROXY = 'ie-proxy';
const OUTER = 'ie-proxy-outer';

/**
 * Opened at module level, not in `before`: the doors are derived from the built tool registry, and importing it
 * loads the config module, which fixes its path at import — so the harness (which sets that path) has to be open first.
 * The cases below are loops over the derived doors, so they need them when the file is read.
 */
const doors = skip ? null : await openInlineEdgeDoors({
  suite: 'inlineedge',
  spaces: [
    { id: STRICT, strictLinkage: true, validationMode: 'strict' },
    { id: LAX, strictLinkage: false, validationMode: 'strict' },
    { id: WARN, strictLinkage: true, validationMode: 'warn' },
  ],
  proxies: [{ id: PROXY, proxyFor: [STRICT, WARN] }, { id: OUTER, proxyFor: [PROXY] }],
});
const env = doors?.env ?? {};
const DOORS = skip ? [] : await inlineEdgeDoors(env);

const TO_KINDS = Object.keys(FAR_ENDS);

describe('an inline edge that is refused writes nothing, on every door', { skip }, () => {
  const oracles = new Map();

  after(async () => { await doors?.close(); });

  /** The space as every case starts it. */
  const fresh = (space) => seedInlineEdgeSpace(env, space);

  /** What this door answers for the record's own refusal, taken once, on a strict seeded space. */
  async function oracleOf(d) {
    if (!oracles.has(d.name)) {
      await fresh(STRICT);
      oracles.set(d.name, await ownRefusal(d, STRICT));
    }
    return oracles.get(d.name);
  }

  /** Send a record and its edges the way this door takes them: a create marks a new record, an update edits its seeded one. */
  function attempt(d, space, edges, { marker, record, patch, id } = {}) {
    const target = d.verb === 'update' ? (id ?? KINDS[d.kind].updId) : undefined;
    const fields = d.verb === 'update'
      ? { description: EDITED_DESCRIPTION, ...(patch ?? {}), edges }
      : { ...(record ?? KINDS[d.kind].valid(marker)), edges };
    return d.send(space, { fields, id: target });
  }

  /** The record a write addressed: a create's is looked up by its marker, an update's is the one it edited. */
  async function subjectOf(d, space, marker, id) {
    if (d.verb === 'update') return id ?? KINDS[d.kind].updId;
    const found = await d.found(space, marker);
    assert.equal(found.length, 1, `${d.name} stored ${JSON.stringify(found)} for the marker "${marker}", expected one record`);
    return found[0];
  }

  /** What a refused write may leave behind: the record as it was (or no record at all), and no edge. */
  async function assertNothingWritten(d, space, { marker, id, before }) {
    if (before !== undefined) {
      assert.deepEqual(await d.stored(space, id), before, `${d.name}: the record was changed by a write that was refused`);
    } else {
      assert.deepEqual(await d.found(space, marker), [], `${d.name}: a record was stored by a write that was refused`);
    }
    assert.deepEqual(await d.edgesIn(space), [], `${d.name}: an edge was stored by a write that was refused`);
  }

  /** The refusal is this door's own for the record, it is not a server error, and it says which edge it refused. */
  async function assertRefusedAsTheRecordIs(d, answer, { edgeIndex } = {}) {
    const oracle = await oracleOf(d);
    assert.ok(answer.refusal, `${d.name} accepted the write (${answer.status}: ${answer.text.slice(0, 300)})`);
    if (!d.bulk) assert.ok(answer.status < 500, `${d.name} answered ${answer.status} — a refused edge is the caller's, not a server error: ${answer.text.slice(0, 300)}`);
    assert.deepEqual(refusalDifferences(d, answer, oracle), [], `${d.name}: the refusal is not the record's own — ${answer.text.slice(0, 300)}`);
    // Every door names the edge it refused (`edges[i]`): a single-record door in its body, a bulk item in its `reason` (plan §6, §7).
    if (edgeIndex !== undefined) {
      assert.match(answer.text, new RegExp(`edges\\[${edgeIndex}\\]`), `${d.name}: the refusal does not name the edge it refused`);
    }
  }

  it('the table found its doors: both surfaces, create and update, and bulk on both', () => {
    for (const channel of ['rest', 'mcp']) {
      for (const [verb, bulk] of [['create', false], ['update', false], ['create', true]]) {
        for (const kind of Object.keys(KINDS)) {
          assert.ok(DOORS.some(d => d.channel === channel && d.verb === verb && d.bulk === bulk && d.kind === kind),
            `no ${channel} ${bulk ? 'bulk' : verb} door for ${kind}`);
        }
      }
    }
  });

  describe('control: a valid inline edge is stored with its record', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(STRICT);
        const m = `control ${d.name}`;
        const answer = await attempt(d, STRICT, [edge(LABELS.plain, FAR_ENDS.entity.exists)], { marker: m });
        assert.equal(answer.refusal, null, `${d.name} refused a valid record with a valid edge (${answer.status}: ${answer.text.slice(0, 300)})`);
        const subject = await subjectOf(d, STRICT, m);
        assert.deepEqual(await d.edgesIn(STRICT), [{ from: subject, to: IDS.BOB, label: LABELS.plain }]);
      });
    }
  });

  describe('a refused label writes neither the record nor the edge that was valid beside it', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(STRICT);
        const oracle = await oracleOf(d);
        assert.ok(oracle.refusal, 'the oracle must be a refusal');
        await fresh(STRICT);
        const m = `label ${d.name}`;
        const before = d.verb === 'update' ? await d.stored(STRICT, KINDS[d.kind].updId) : undefined;
        const answer = await attempt(d, STRICT, [edge(LABELS.plain, FAR_ENDS.entity.exists), edge(LABELS.undeclared, FAR_ENDS.entity.exists)], { marker: m });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 1 });
        await assertNothingWritten(d, STRICT, { marker: m, id: KINDS[d.kind].updId, before });
      });
    }
  });

  describe('a subject of a type the label does not allow writes nothing', () => {
    const entityDoors = DOORS.filter(d => d.kind === 'entity');
    it('the table has the entity doors (an endpoint rule is about an entity subject)', () => {
      assert.ok(entityDoors.length >= 6, `only ${entityDoors.length} entity doors`);
    });
    for (const d of entityDoors) {
      it(d.name, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        const m = `endpoint ${d.name}`;
        const id = IDS.UPD_DOC_ENTITY;
        const before = d.verb === 'update' ? await d.stored(STRICT, id) : undefined;
        const answer = await attempt(d, STRICT, [edge(LABELS.endpoints, FAR_ENDS.entity.exists)], { marker: m, record: { name: m, type: 'document' }, id });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
        await assertNothingWritten(d, STRICT, { marker: m, id, before });
      });
    }
  });

  describe('two edges under one functional label in one body write nothing', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        const m = `functional ${d.name}`;
        const before = d.verb === 'update' ? await d.stored(STRICT, KINDS[d.kind].updId) : undefined;
        const answer = await attempt(d, STRICT, [edge(LABELS.functional, { to: IDS.ALICE }), edge(LABELS.functional, { to: IDS.BOB })], { marker: m });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 1 });
        await assertNothingWritten(d, STRICT, { marker: m, id: KINDS[d.kind].updId, before });
      });
    }
  });

  for (const toKind of TO_KINDS) {
    describe(`a missing ${toKind} at the far end, on a strict space, writes nothing and is not a server error`, () => {
      for (const d of DOORS) {
        it(d.name, async () => {
          await fresh(STRICT);
          await oracleOf(d);
          await fresh(STRICT);
          const m = `dangling ${toKind} ${d.name}`;
          const before = d.verb === 'update' ? await d.stored(STRICT, KINDS[d.kind].updId) : undefined;
          const answer = await attempt(d, STRICT, [edge(LABELS.plain, FAR_ENDS[toKind].dangling)], { marker: m });
          await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
          await assertNothingWritten(d, STRICT, { marker: m, id: KINDS[d.kind].updId, before });
        });
      }
    });

    describe(`the same missing ${toKind} on a lax space is STORED`, () => {
      for (const d of DOORS) {
        it(d.name, async () => {
          await fresh(LAX);
          const m = `lax ${toKind} ${d.name}`;
          const answer = await attempt(d, LAX, [edge(LABELS.plain, FAR_ENDS[toKind].dangling)], { marker: m });
          assert.equal(answer.refusal, null, `${d.name} refused a dangling ${toKind} on a space that allows dangling references (${answer.status}: ${answer.text.slice(0, 300)})`);
          const subject = await subjectOf(d, LAX, m);
          assert.deepEqual(await d.edgesIn(LAX), [{ from: subject, to: FAR_ENDS[toKind].dangling.to, label: LABELS.plain }]);
        });
      }
    });
  }

  for (const toKind of TO_KINDS.filter(k => k !== 'entity')) {
    describe(`an existing ${toKind} at the far end is stored, not a server error`, () => {
      for (const d of DOORS) {
        it(d.name, async () => {
          await fresh(STRICT);
          const m = `far ${toKind} ${d.name}`;
          const answer = await attempt(d, STRICT, [edge(LABELS.plain, FAR_ENDS[toKind].exists)], { marker: m });
          assert.equal(answer.refusal, null, `${d.name} refused an edge to an existing ${toKind} (${answer.status}: ${answer.text.slice(0, 300)})`);
          const subject = await subjectOf(d, STRICT, m);
          assert.deepEqual(await d.edgesIn(STRICT), [{ from: subject, to: FAR_ENDS[toKind].exists.to, label: LABELS.plain }]);
        });
      }
    });
  }

  describe('a malformed edge is refused on every single-record door as REST POST refuses it', () => {
    const SHAPES = [
      ['a whitespace-only label', [{ label: '   ', to: IDS.BOB }]],
      ['a malformed `to`', [{ label: LABELS.plain, to: 'not-a-uuid' }]],
    ];
    const singles = DOORS.filter(d => !d.bulk);
    it('the table has the doors this rule is about (MCP create and update, REST PATCH)', () => {
      assert.ok(singles.filter(d => d.channel === 'mcp').length >= 6 && singles.filter(d => d.channel === 'rest' && d.verb === 'update').length >= 3);
    });
    for (const [what, edges] of SHAPES) {
      for (const d of singles) {
        it(`${what}: ${d.name}`, async () => {
          await fresh(STRICT);
          const post = DOORS.find(x => x.channel === 'rest' && x.verb === 'create' && !x.bulk && x.kind === d.kind);
          const refusedByPost = await attempt(post, STRICT, edges, { marker: `post ${what} ${d.name}` });
          assert.ok(refusedByPost.refusal, `REST POST accepted ${what} — the oracle for this case is gone`);
          await fresh(STRICT);
          const m = `shape ${what} ${d.name}`;
          const before = d.verb === 'update' ? await d.stored(STRICT, KINDS[d.kind].updId) : undefined;
          const answer = await attempt(d, STRICT, edges, { marker: m });
          assert.ok(answer.refusal, `${d.name} accepted ${what}, which REST POST refuses with ${refusedByPost.status}: ${answer.text.slice(0, 300)}`);
          assert.equal(answer.status, refusedByPost.status, `${d.name} answered ${answer.status} for ${what}, REST POST answers ${refusedByPost.status}`);
          assert.ok(answer.text.includes(refusedByPost.body.error), `${d.name}: the refusal does not say what REST POST says (${refusedByPost.body.error}): ${answer.text.slice(0, 300)}`);
          await assertNothingWritten(d, STRICT, { marker: m, id: KINDS[d.kind].updId, before });
        });
      }
    }
  });

  describe('a create door that converges onto a stored record leaves it unchanged when its edge is refused', () => {
    const creates = DOORS.filter(d => d.verb === 'create');
    it('the table has create doors, bulk included', () => {
      assert.ok(creates.length >= 12 && creates.some(d => d.bulk), `${creates.length} create doors`);
    });
    for (const d of creates) {
      it(d.name, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        const id = KINDS[d.kind].updId;
        const before = await d.stored(STRICT, id);
        assert.ok(before, 'the fixture record is missing');
        const m = `converge ${d.name}`;
        const answer = await attempt(d, STRICT, [edge(LABELS.undeclared, FAR_ENDS.entity.exists)], { marker: m, record: { ...KINDS[d.kind].valid(m), id, description: EDITED_DESCRIPTION } });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
        assert.deepEqual(await d.stored(STRICT, id), before, `${d.name}: the stored record was converged by a write that was refused`);
        assert.deepEqual(await d.found(STRICT, m), [], `${d.name}: a second record appeared under the marker`);
        assert.deepEqual(await d.edgesIn(STRICT), [], `${d.name}: an edge was stored by a write that was refused`);
      });
    }
  });

  describe('re-sending a stored functional edge is accepted (an edge is not its own duplicate)', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(STRICT);
        const m = `again ${d.name}`;
        const edges = [edge(LABELS.functional, { to: IDS.ALICE })];
        const first = await attempt(d, STRICT, edges, { marker: m });
        assert.equal(first.refusal, null, `${d.name} refused the first write (${first.status}: ${first.text.slice(0, 300)})`);
        const subject = await subjectOf(d, STRICT, m);
        const again = d.verb === 'update'
          ? await attempt(d, STRICT, edges, { marker: m })
          : await attempt(d, STRICT, edges, { marker: m, record: { ...KINDS[d.kind].valid(m), id: subject } });
        assert.equal(again.refusal, null, `${d.name} refused the same functional edge again — it was counted against itself (${again.status}: ${again.text.slice(0, 300)})`);
        assert.deepEqual(await d.edgesIn(STRICT), [{ from: subject, to: IDS.ALICE, label: LABELS.functional }]);
      });
    }
  });

  describe('on a space that only warns, the record and the edge are both written', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(WARN);
        const m = `warn ${d.name}`;
        const answer = await attempt(d, WARN, [edge(LABELS.undeclared, FAR_ENDS.entity.exists)], { marker: m });
        assert.equal(answer.refusal, null, `${d.name} refused on a space whose validationMode is warn (${answer.status}: ${answer.text.slice(0, 300)})`);
        const subject = await subjectOf(d, WARN, m);
        assert.deepEqual(await d.edgesIn(WARN), [{ from: subject, to: IDS.BOB, label: LABELS.undeclared }]);
      });
    }
  });

  describe('an update of an id nothing is stored under is a 404, not the edge refusal', () => {
    const updates = DOORS.filter(d => d.verb === 'update');
    it('the table has update doors on both surfaces', () => {
      assert.ok(updates.length >= 6 && updates.some(d => d.channel === 'rest') && updates.some(d => d.channel === 'mcp'));
    });
    const BAD = [
      ['an undeclared label', edge(LABELS.undeclared, FAR_ENDS.entity.exists)],
      ['a far end that is missing', edge(LABELS.plain, FAR_ENDS.entity.dangling)],
    ];
    for (const [what, bad] of BAD) {
      for (const d of updates) {
        it(`${what}: ${d.name}`, async () => {
          await fresh(STRICT);
          const nothing = await d.send(STRICT, { fields: { description: EDITED_DESCRIPTION }, id: IDS.NOBODY });
          assert.ok(nothing.refusal, `${d.name} accepted an update of an id nothing is stored under — the oracle for this case is gone`);
          await fresh(STRICT);
          const answer = await d.send(STRICT, { fields: { description: EDITED_DESCRIPTION, edges: [bad] }, id: IDS.NOBODY });
          assert.deepEqual(refusalDifferences(d, answer, nothing), [], `${d.name}: the missing record was not answered as missing — ${answer.text.slice(0, 300)}`);
          assert.equal(answer.status, nothing.status);
          assert.deepEqual(await d.edgesIn(STRICT), [], `${d.name}: an edge was stored for a record that does not exist`);
        });
      }
    }
  });

  describe('a pre-existing violation does not block an unrelated edge', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh(STRICT);
        const subject = KINDS[d.kind].updId;
        // Stored BEFORE the write, straight into the collection: a label the schema does not declare, and two edges under a
        // functional label — both break a rule the subject's next, unrelated edge has nothing to do with.
        const from = d.kind === 'entity' ? {} : { fromKind: d.kind };
        const stored = [
          build.edge(STRICT, 'pre-undeclared', 3, { from: subject, to: IDS.ALICE, label: LABELS.undeclared, ...from }),
          build.edge(STRICT, 'pre-functional-a', 3, { from: subject, to: IDS.ALICE, label: LABELS.functional, ...from }),
          build.edge(STRICT, 'pre-functional-b', 3, { from: subject, to: IDS.BOB, label: LABELS.functional, ...from }),
        ];
        await env.door.coll(STRICT, 'edges').insertMany(stored);
        const m = `pre-existing ${d.name}`;
        const answer = await attempt(d, STRICT, [edge(LABELS.plain, FAR_ENDS.entity.exists)],
          { marker: m, record: { ...KINDS[d.kind].valid(m), id: subject } });
        assert.equal(answer.refusal, null, `${d.name} refused an unrelated valid edge because the subject already held violations (${answer.status}: ${answer.text.slice(0, 300)})`);
        const edges = (await d.edgesIn(STRICT)).map(e => `${e.from}|${e.label}|${e.to}`).sort();
        const expected = [
          ...stored.map(e => `${e.from}|${e.label}|${e.to}`),
          `${subject}|${LABELS.plain}|${IDS.BOB}`,
        ].sort();
        assert.deepEqual(edges, expected);
      });
    }
  });

  describe('a REST PATCH with a stale If-Match AND a refused inline edge answers the refusal, not 412', () => {
    // MCP has no `If-Match` (no parameter carries one), so the ordering of the two refusals is a REST-only question.
    const patches = DOORS.filter(d => d.channel === 'rest' && d.verb === 'update');
    it('the table has the REST PATCH doors', () => {
      assert.ok(patches.length >= 3, `${patches.length} REST update doors`);
    });
    const STALE = { 'If-Match': '1' };
    for (const d of patches) {
      it(d.name, async () => {
        await fresh(STRICT);
        const id = KINDS[d.kind].updId;
        const precondition = await d.send(STRICT, { fields: { description: EDITED_DESCRIPTION }, id, headers: STALE });
        assert.equal(precondition.status, 412, `${d.name}: a stale If-Match alone must be 412 — the oracle for this case is gone (${precondition.status})`);
        const oracle = await oracleOf(d);
        await fresh(STRICT);
        const before = await d.stored(STRICT, id);
        const answer = await d.send(STRICT, { fields: { description: EDITED_DESCRIPTION, edges: [edge(LABELS.undeclared, FAR_ENDS.entity.exists)] }, id, headers: STALE });
        assert.notEqual(answer.status, 412, `${d.name} answered the stale precondition and never looked at the refused edge`);
        assert.deepEqual(refusalDifferences(d, answer, oracle), [], `${d.name}: the refusal is not the record's own — ${answer.text.slice(0, 300)}`);
        assert.deepEqual(await d.stored(STRICT, id), before);
        assert.deepEqual(await d.edgesIn(STRICT), []);
      });
    }
  });

  describe('an update through a proxy is judged by the schema of the member that holds the record', () => {
    // PROXY's members are a strict one and a warn-only one: the SAME edge (an undeclared label) is refused by one and written by the other.
    const updates = DOORS.filter(d => d.verb === 'update');
    const BAD = [edge(LABELS.undeclared, FAR_ENDS.entity.exists)];
    for (const d of updates) {
      it(`a member whose schema allows the edge takes it: ${d.name}`, async () => {
        await fresh(STRICT);
        await fresh(WARN);
        const id = KINDS[d.kind].updId;
        const answer = await d.send(PROXY, { fields: { description: EDITED_DESCRIPTION, edges: BAD }, id, targetSpace: WARN });
        assert.equal(answer.refusal, null, `${d.name} refused through a proxy an edge the member's schema allows (${answer.status}: ${answer.text.slice(0, 300)})`);
        assert.deepEqual(await d.edgesIn(WARN), [{ from: id, to: IDS.BOB, label: LABELS.undeclared }]);
        assert.deepEqual(await d.edgesIn(STRICT), [], `${d.name}: the edge landed in the other member`);
      });

      it(`a member whose schema refuses the edge refuses it, and nothing is written: ${d.name}`, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        await fresh(WARN);
        const id = KINDS[d.kind].updId;
        const before = await d.stored(STRICT, id);
        const answer = await d.send(PROXY, { fields: { description: EDITED_DESCRIPTION, edges: BAD }, id, targetSpace: STRICT });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
        assert.deepEqual(await d.stored(STRICT, id), before);
        assert.deepEqual(await d.edgesIn(STRICT), []);
        assert.deepEqual(await d.edgesIn(WARN), []);
      });

      it(`a proxy that is itself the declared target does not decide: the member holding the record does: ${d.name}`, async () => {
        await fresh(STRICT);
        await fresh(WARN);
        const id = KINDS[d.kind].updId;
        // The record lives ONLY in the warn-only member, so it is that member's schema — not the strict one the search
        // passes first, and not the proxy's, which has none — that must judge the edge.
        await env.door.coll(STRICT, KINDS[d.kind].coll).deleteOne({ _id: id });
        const answer = await d.send(OUTER, { fields: { description: EDITED_DESCRIPTION, edges: BAD }, id, targetSpace: PROXY });
        assert.equal(answer.refusal, null, `${d.name} refused an edge the holding member's schema allows (${answer.status}: ${answer.text.slice(0, 300)})`);
        assert.deepEqual(await d.edgesIn(WARN), [{ from: id, to: IDS.BOB, label: LABELS.undeclared }]);
      });

      it(`a proxy that is itself the declared target does not decide: the member holding the record refuses what its schema refuses: ${d.name}`, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        await fresh(WARN);
        const id = KINDS[d.kind].updId;
        await env.door.coll(WARN, KINDS[d.kind].coll).deleteOne({ _id: id });
        const before = await d.stored(STRICT, id);
        const answer = await d.send(OUTER, { fields: { description: EDITED_DESCRIPTION, edges: BAD }, id, targetSpace: PROXY });
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
        assert.deepEqual(await d.stored(STRICT, id), before);
        assert.deepEqual(await d.edgesIn(STRICT), []);
      });
    }
  });

  describe('an entity update that changes the subject type is judged by the type it leaves', () => {
    const entityDoors = DOORS.filter(d => d.kind === 'entity');
    /** The same record, retyped, with `edges` in the same call — an update's patch, or a create/bulk converging onto its id. */
    const retype = (d, id, type, edges, marker) => d.verb === 'update'
      ? attempt(d, STRICT, edges, { patch: { type }, id })
      : attempt(d, STRICT, edges, { marker, record: { ...KINDS.entity.valid(marker), type, id } });
    for (const d of entityDoors) {
      it(`a label valid only for the NEW type is accepted in the call that sets it: ${d.name}`, async () => {
        await fresh(STRICT);
        const id = IDS.UPD_DOC_ENTITY;
        const answer = await retype(d, id, 'person', [edge(LABELS.endpoints, FAR_ENDS.entity.exists)], `retype ${d.name}`);
        assert.equal(answer.refusal, null, `${d.name} judged the edge by the type the record is leaving (${answer.status}: ${answer.text.slice(0, 300)})`);
        assert.equal((await d.stored(STRICT, id)).type, 'person');
        assert.deepEqual(await d.edgesIn(STRICT), [{ from: id, to: IDS.BOB, label: LABELS.endpoints }]);
      });

      it(`a label that the NEW type breaks is refused, and the record keeps its old type: ${d.name}`, async () => {
        await fresh(STRICT);
        await oracleOf(d);
        await fresh(STRICT);
        const id = IDS.UPD_ENTITY;
        const before = await d.stored(STRICT, id);
        const answer = await retype(d, id, 'document', [edge(LABELS.endpoints, FAR_ENDS.entity.exists)], `retype away ${d.name}`);
        await assertRefusedAsTheRecordIs(d, answer, { edgeIndex: 0 });
        assert.deepEqual(await d.stored(STRICT, id), before, `${d.name}: the record was retyped by a write that was refused`);
        assert.deepEqual(await d.edgesIn(STRICT), []);
      });
    }
  });
});
