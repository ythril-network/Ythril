/**
 * A record near the ceiling is held to the ceiling, and nothing a peer sends can lift this instance's own versions to it
 * (bundle-81, Q-241, plan rev 8 §1a and §9 test 5).
 *
 * ## The defect
 *
 * An arrival moves the space counter V (`bumpSeq`, clamped at `MAX_INGEST_SEQ`). So one peer record at `MAX_INGEST_SEQ` drags V to
 * the ceiling, and the next LOCAL create is stamped `MAX_INGEST_SEQ + 1`: above what every peer accepts (`isSeqImplausible`), so
 * every receiver refuses it, for ever, with nothing on this side saying so.
 *
 * ## The rules this file holds (rev 8 §1a, decisions 2, 14 and 15)
 *
 *  1. Records at `MAX_INGEST_SEQ` and `MAX_INGEST_SEQ - k` arrive by push and by pull and are stored at their own seq.
 *  2. **An arrival never moves V** (D-19 B): V stays at or below `VERSION_FLOOR_CAP = MAX_INGEST_SEQ - SEQ_CEILING_RESERVE`.
 *  3. A local create after them is accepted by a REAL second receiver (the real push route, which applies `isSeqImplausible`).
 *  4. A local edit of the near-ceiling record is stamped one above it and does not raise V.
 *  5. An edit AND a delete of the record AT the ceiling answer `record_version_at_ceiling` with its `code`, on REST and on MCP, in
 *     one sentence, and change nothing.
 *  6. A merge touching it is refused whole.
 *  7. A housekeeping walk (the retention sweep) skips it, counts it (`ythril_brain_write_seq_total{outcome="ceiling"}`), and
 *     the walk goes on to the records behind it.
 *  8. A refused fork answers `rejected` (this one is already true at 9a7ab3f7: the plan says "only its test is owed").
 *
 * ## What is derived and what is literal
 *
 * The ceiling, the reserve and the cap are READ from `util/seq.js` (`VERSION_FLOOR_CAP` is `MAX_INGEST_SEQ - SEQ_CEILING_RESERVE`
 * by the plan's own definition, so it is computed here, not copied). The refusal's code is the wire value the plan names, written
 * once below; the plan puts it in a constant exported from `brain/write-precondition.ts`, and that is asserted by VALUE
 * (some export of that module carries it), because the plan does not name the export.
 *
 * Database `b81tC_q241`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/q241-a-near-ceiling-record-is-held-to-the-ceiling-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';
import { build, peerToken } from './_push-door.mjs';

const skip = await mongoSkipReason();

const seq = await import('../../server/dist/util/seq.js');
const CEILING = seq.MAX_INGEST_SEQ;
const CAP = seq.MAX_INGEST_SEQ - seq.SEQ_CEILING_RESERVE; // VERSION_FLOOR_CAP
const K = 3;
const NEAR = CEILING - K;
const REFUSAL = 'record_version_at_ceiling';
const PEER = 'q241-peer';
const TOKEN = peerToken(PEER);

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FACT_CEIL = U(1), FACT_NEAR = U(2), FACT_FORK = U(3);
const ENT_CEIL = U(10), ENT_OTHER = U(11), ENT_SURVIVOR = U(12);

// One space per case, so no case inherits another's counter or in-process seq state.
const SPACES = ['arrive-push', 'arrive-pull', 'recv', 'edit', 'ceil', 'merge-a', 'merge-b', 'ttl', 'fork'];

describe('a near-ceiling record is held to the ceiling', { skip }, () => {
  let door;
  const author = { instanceId: PEER, instanceLabel: 'Peer' };
  const fact = (space, id, s, extra = {}) => build.fact(space, id, s, { author, ...extra });
  const entity = (space, id, s, extra = {}) => build.entity(space, id, s, { author, ...extra });

  before(async () => {
    door = await openB81cDoor({ name: 'q241', spaces: SPACES, app: true });
  });
  after(async () => { await door?.close(); });

  /** A batch push of docs into `space`; asserts the door answered at all. */
  async function pushBatch(space, body) {
    const r = await door.push('/batch-upsert', body, { spaceId: space, token: TOKEN });
    assert.equal(r.code, 200, `batch-upsert answered ${r.code}: ${JSON.stringify(r.body)}`);
    return r;
  }
  const stored = (space, part, id) => door.coll(space, part).findOne({ _id: id });

  describe('arrivals', () => {
    before(async () => {
      await pushBatch('arrive-push', { facts: [fact('arrive-push', FACT_CEIL, CEILING), fact('arrive-push', FACT_NEAR, NEAR)] });
      // The pull door lands a page through `acceptArrivingPage` (`sync/pull-family.ts` calls it with `door: 'pull'`).
      const { acceptArrivingPage } = await import('../../server/dist/sync/accept-page.js');
      const { LinkageCheck } = await import('../../server/dist/sync/linkage-check.js');
      const out = await acceptArrivingPage('arrive-pull',
        { facts: [fact('arrive-pull', FACT_CEIL, CEILING), fact('arrive-pull', FACT_NEAR, NEAR)] },
        { door: 'pull', deliveredBy: PEER, from: 'Peer', linkage: new LinkageCheck('arrive-pull', PEER) });
      assert.ok(out.facts.verdicts.length === 2 && !out.facts.verdicts.includes('rejected'),
        `the pull door refused a record at or below the ceiling: ${JSON.stringify(out.facts.verdicts)} ${JSON.stringify(out.facts.reasons)}`);
    });

    for (const space of ['arrive-push', 'arrive-pull']) {
      it(`${space}: records at MAX_INGEST_SEQ and MAX_INGEST_SEQ - ${K} are stored at their own seq (control: true today)`, async () => {
        assert.equal((await stored(space, 'facts', FACT_CEIL))?.seq, CEILING);
        assert.equal((await stored(space, 'facts', FACT_NEAR))?.seq, NEAR);
      });

      it(`${space}: an arrival does not move V (the counter stays at or below VERSION_FLOOR_CAP)`, async () => {
        const v = await door.counter(space);
        assert.ok(v <= CAP,
          `the counter of '${space}' is ${v} after two arrivals at ${CEILING} and ${NEAR}: an arrival dragged V above `
          + `VERSION_FLOOR_CAP (${CAP}), so the next local stamp is ${v + 1}`);
      });
    }

    it('a local create after the arrivals is stamped at or below the ceiling and a REAL second receiver accepts it', async () => {
      const made = await door.rest('POST', '/api/brain/spaces/arrive-push/facts', { fact: 'a local fact after the arrivals' });
      assert.equal(made.status, 201, made.text);
      const row = await stored('arrive-push', 'facts', made.body._id);
      assert.ok(row, 'the created fact is not stored');
      assert.ok(row.seq <= CEILING,
        `the local create was stamped ${row.seq}, above MAX_INGEST_SEQ (${CEILING}): no receiver accepts it`);
      // The real receiver: the real single-document push route, on another space, which applies the shape and ceiling rule.
      const { _id, spaceId, ...rest } = row;
      void spaceId;
      const sent = await door.push('/facts', { ...rest, _id, spaceId: 'recv' }, { spaceId: 'recv', token: TOKEN });
      assert.equal(sent.code, 200, `the receiver refused the local create (seq ${row.seq}): ${JSON.stringify(sent.body)}`);
      assert.equal((await stored('recv', 'facts', _id))?.seq, row.seq, 'the receiver does not hold the create at the seq it was sent');
    });
  });

  describe('a local edit of the near-ceiling record', () => {
    it('is stamped one above it, answers 200, and does not raise V', async () => {
      await pushBatch('edit', { facts: [fact('edit', FACT_NEAR, NEAR)] });
      const r = await door.rest('PATCH', `/api/brain/spaces/edit/facts/${FACT_NEAR}`, { fact: 'edited near the ceiling' });
      assert.equal(r.status, 200, r.text);
      assert.equal((await stored('edit', 'facts', FACT_NEAR))?.seq, NEAR + 1,
        'an edit takes max(V + 1, held seq + 1): one above the record it replaces, whatever the counter says');
      const v = await door.counter('edit');
      assert.ok(v <= CAP, `editing a near-ceiling record raised V to ${v}, above VERSION_FLOOR_CAP (${CAP})`);
      const made = await door.rest('POST', '/api/brain/spaces/edit/facts', { fact: 'a create after the edit' });
      assert.equal(made.status, 201, made.text);
      const created = await stored('edit', 'facts', made.body._id);
      assert.ok(created.seq <= CAP, `a create after the edit was stamped ${created.seq}, above VERSION_FLOOR_CAP (${CAP})`);
    });
  });

  describe('a record AT the ceiling', () => {
    /** Every door that stamps a version on a record of one family, with how to call it and what must not change. */
    const doors = (space) => [
      { family: 'facts', id: FACT_CEIL, part: 'facts', door: 'REST', op: 'edit',
        call: () => door.rest('PATCH', `/api/brain/spaces/${space}/facts/${FACT_CEIL}`, { fact: 'edit at the ceiling' }) },
      { family: 'facts', id: FACT_CEIL, part: 'facts', door: 'REST', op: 'delete',
        call: () => door.rest('DELETE', `/api/brain/spaces/${space}/facts/${FACT_CEIL}`) },
      { family: 'facts', id: FACT_CEIL, part: 'facts', door: 'MCP', op: 'edit',
        call: () => door.mcp('update_fact', { space, id: FACT_CEIL, fact: 'edit at the ceiling' }) },
      { family: 'facts', id: FACT_CEIL, part: 'facts', door: 'MCP', op: 'delete',
        call: () => door.mcp('delete_fact', { space, id: FACT_CEIL }) },
      { family: 'entities', id: ENT_CEIL, part: 'entities', door: 'REST', op: 'edit',
        call: () => door.rest('PATCH', `/api/brain/spaces/${space}/entities/${ENT_CEIL}`, { description: 'edit at the ceiling' }) },
      { family: 'entities', id: ENT_CEIL, part: 'entities', door: 'REST', op: 'delete',
        call: () => door.rest('DELETE', `/api/brain/spaces/${space}/entities/${ENT_CEIL}`) },
      { family: 'entities', id: ENT_CEIL, part: 'entities', door: 'MCP', op: 'edit',
        call: () => door.mcp('update_entity', { space, id: ENT_CEIL, description: 'edit at the ceiling' }) },
      { family: 'entities', id: ENT_CEIL, part: 'entities', door: 'MCP', op: 'delete',
        call: () => door.mcp('delete_entity', { space, id: ENT_CEIL }) },
    ];

    it('the refusal code is a constant exported from brain/write-precondition (the module that owns a write\'s version outcome)', async () => {
      const mod = await moduleOrNull('brain/write-precondition.js');
      assert.ok(mod, 'brain/write-precondition.js is missing');
      assert.ok(Object.values(mod).includes(REFUSAL),
        `no export of brain/write-precondition carries '${REFUSAL}': the plan names the module as the one place the code lives`);
    });

    it('the table covers both doors and both operations on at least two families (a floor, so an empty table cannot pass)', () => {
      const t = doors('ceil');
      assert.ok(t.length >= 8);
      assert.deepEqual([...new Set(t.map(d => d.door))].sort(), ['MCP', 'REST']);
      assert.deepEqual([...new Set(t.map(d => d.op))].sort(), ['delete', 'edit']);
    });

    for (const d of doors('ceil')) {
      it(`${d.door} ${d.op} of a ${d.family} record at MAX_INGEST_SEQ answers ${REFUSAL}, with its code, and changes nothing`, async () => {
        await door.wipe('ceil');
        await pushBatch('ceil', {
          facts: [fact('ceil', FACT_CEIL, CEILING)],
          entities: [entity('ceil', ENT_CEIL, CEILING)],
        });
        const before = await stored('ceil', d.part, d.id);
        assert.equal(before?.seq, CEILING, 'the fixture record is not at the ceiling');
        const r = await d.call();
        assert.equal(r.status, 409, `${d.door} ${d.op} answered ${r.status}, not the 409 refusal: ${r.text.slice(0, 300)}`);
        assert.equal(r.body?.code, REFUSAL, `${d.door} ${d.op}: the refusal carries no code '${REFUSAL}': ${r.text.slice(0, 300)}`);
        assert.equal(r.body?.id, d.id, `${d.door} ${d.op}: the refusal does not name the record`);
        const sentence = d.door === 'REST' ? r.body?.error : r.text;
        assert.equal(typeof sentence, 'string');
        assert.match(sentence, /\S{3,}/);
        const after = await stored('ceil', d.part, d.id);
        assert.deepEqual(after, before, 'the refused write changed the stored record');
        assert.equal(await door.coll('ceil', 'tombstones').countDocuments({ _id: d.id }), 0, 'a refused delete left a tombstone');
        assert.ok(await door.counter('ceil') <= CAP, 'the refused write moved V');
      });
    }

    it('REST and MCP answer in one sentence (the same words on both doors)', async () => {
      await door.wipe('ceil');
      await pushBatch('ceil', { facts: [fact('ceil', FACT_CEIL, CEILING)] });
      const rest = await door.rest('PATCH', `/api/brain/spaces/ceil/facts/${FACT_CEIL}`, { fact: 'x' });
      const mcp = await door.mcp('update_fact', { space: 'ceil', id: FACT_CEIL, fact: 'x' });
      assert.equal(rest.body?.code, REFUSAL, rest.text);
      assert.equal(mcp.body?.code, REFUSAL, mcp.text);
      assert.ok(mcp.text.includes(rest.body.error), `MCP says '${mcp.text}', REST says '${rest.body.error}'`);
    });
  });

  describe('a merge touching a record at the ceiling', () => {
    for (const role of ['absorbed', 'survivor']) {
      for (const via of ['REST', 'MCP']) {
        it(`${via}: the ceiling entity is the ${role}: the merge is refused whole and nothing is half-merged`, async () => {
          const space = via === 'REST' ? 'merge-a' : 'merge-b';
          await door.wipe(space);
          // survivor <- absorbed; the ceiling entity takes `role`, and an edge leaves the absorbed one so a merge has something to relink.
          const survivorId = role === 'survivor' ? ENT_CEIL : ENT_SURVIVOR;
          const absorbedId = role === 'absorbed' ? ENT_CEIL : ENT_OTHER;
          const thirdId = role === 'absorbed' ? ENT_OTHER : ENT_SURVIVOR;
          await pushBatch(space, {
            entities: [
              entity(space, survivorId, role === 'survivor' ? CEILING : 5),
              entity(space, absorbedId, role === 'absorbed' ? CEILING : 5),
              entity(space, thirdId, 5),
            ],
            edges: [build.edge(space, U(40), 5, { author, from: absorbedId, to: thirdId })],
          });
          const rowsBefore = async () => ({
            entities: await door.coll(space, 'entities').find({}).sort({ _id: 1 }).toArray(),
            edges: await door.coll(space, 'edges').find({}).sort({ _id: 1 }).toArray(),
            tombstones: await door.coll(space, 'tombstones').countDocuments({}),
          });
          const before = await rowsBefore();
          const r = via === 'REST'
            ? await door.rest('POST', `/api/brain/spaces/${space}/entities/${survivorId}/merge/${absorbedId}`, {})
            : await door.mcp('graph_merge', { space, survivorId, absorbedId });
          assert.equal(r.status, 409, `${via} merge answered ${r.status}, not the 409 refusal: ${r.text.slice(0, 300)}`);
          assert.equal(r.body?.code, REFUSAL, `${via} merge: no code '${REFUSAL}': ${r.text.slice(0, 300)}`);
          assert.deepEqual(await rowsBefore(), before, `${via} merge: the refusal was not whole, something was written`);
        });
      }
    }
  });

  describe('a housekeeping walk', () => {
    it('skips a record at the ceiling, counts it, and goes on to the expired record behind it', async () => {
      await door.wipe('ttl');
      const past = new Date(Date.now() - 60_000);
      await pushBatch('ttl', { facts: [fact('ttl', FACT_CEIL, CEILING), fact('ttl', FACT_NEAR, 7)] });
      await door.coll('ttl', 'facts').updateMany({ _id: { $in: [FACT_CEIL, FACT_NEAR] } }, { $set: { _expireAt: past } });
      const registry = await import('../../server/dist/metrics/registry.js');
      const counted = async () => {
        const m = await registry.brainWriteSeqTotal.get();
        return m.values.filter(v => v.labels.collection === 'facts' && v.labels.outcome === 'ceiling').reduce((a, v) => a + v.value, 0);
      };
      const countedBefore = await counted();
      const { sweepExpiredRecords } = await import('../../server/dist/brain/ttl-sweep.js');
      const { walk } = await sweepExpiredRecords(new Date());
      assert.ok(await stored('ttl', 'facts', FACT_CEIL),
        'the retention sweep deleted the record at the ceiling: its tombstone would be stamped above MAX_INGEST_SEQ');
      assert.equal(await stored('ttl', 'facts', FACT_NEAR), null, 'the walk did not go on to the expired record behind the skipped one');
      assert.equal(await counted() - countedBefore, 1, 'the skipped record was not counted as outcome="ceiling"');
      assert.deepEqual(walk.failed, [], 'a record at the ceiling is skipped, never a space failure');
    });
  });

  describe('a refused fork', () => {
    it('answers rejected and stores no fork (control: already true at 9a7ab3f7, where the plan says only its test is owed)', async () => {
      await pushBatch('fork', { facts: [fact('fork', FACT_FORK, CEILING)] });
      const r = await door.push('/facts', fact('fork', FACT_FORK, CEILING, { fact: 'the same fact, as the peer tells it differently' }),
        { spaceId: 'fork', token: TOKEN });
      assert.notEqual(r.body?.status, 'forked', 'a fork was stamped above the ceiling and stored');
      assert.equal(r.code, 400, `the divergent copy answered ${r.code} ${JSON.stringify(r.body)}, not a refusal`);
      assert.equal(await door.coll('fork', 'facts').countDocuments({}), 1, 'a refused fork left a second row');
    });
  });
});
