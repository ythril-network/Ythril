/**
 * A tombstone a peer plants blocks no create, and a create is never refused for what a peer once deleted
 * (bundle-81, plan rev 8 §1a decisions 1 and 2, §6c, §6e, §9 test 7).
 *
 * ## The defect
 *
 * Two mirror images. A content-id edge (`edgeIdFor`, `linkIdFor`) has an id anyone can compute, so anyone can plant a tombstone for
 * it. If a tombstone raises this instance's counter V (an arrival does, today), one planted at `MAX_INGEST_SEQ` drags V to the
 * ceiling and every later create is stamped above what peers accept. And the other way: a QUIET instance whose counter is far below
 * a deletion another instance issued re-creates the edge at V + 1, below that deletion, and every relay holding the tombstone
 * refuses the create for good (`heldTombstoneRefuses`, `sync/upsert-plan.ts`).
 *
 * ## The rules this file holds (rev 8 decisions 1, 2)
 *
 *  A. B deletes content-id edge E, prunes the tombstone, re-creates E: a real receiver C still holding the tombstone accepts it.
 *  B. QUIET B, holding A's high-seq tombstone for E, re-creates E: the stamp is above the deletion WITHOUT raising V, and a relay
 *     holding the tombstone accepts it. (The stamp counts every held tombstone, whatever its issuer: `min(heldTomb, cap) + 1`.)
 *  C. A peer plants `{_id: edgeIdFor(...), seq: MAX_INGEST_SEQ}` with `instanceId` absent, `''`, `' '`, an unrelated instance and THIS
 *     instance's id, through every door that applies a tombstone:
 *       - blank issuers (absent, `''`, `' '`) are refused alone: nothing is stored;
 *       - the others are stored but never `issuedHere` and are not pushed on the mesh;
 *       - a create of that edge is stamped at most `VERSION_FLOOR_CAP + 1`, is written, and V never moves above `VERSION_FLOOR_CAP`.
 *
 * ## The doors, and what is not driven here
 *
 * Every door applies a page through `applyPeerTombstones` (`sync/tombstone-apply.ts`); what differs is the `Delivery` it builds. Driven:
 * the peer POST (`/api/sync/tombstones`, a peer token), the trusted relay (the same route, an admin token), the pull (a member's
 * delivery), the repair re-read (`{ repair: true }`) and the UPSTREAM ground (a delivery with `upstream: true`: the space is carried by a pub/sub network whose
 * publisher is the planting peer; the verdict for an ABSENT record does not read it, so the rows behave as on the other doors, which is what is held). The restore
 * act loads tombstones raw from a backup and not through the apply, so it is its own file (`a-planted-tombstone-in-a-backup-blocks-no-create-db.test.js`; decision 53). The derivation below fails if a caller of `applyPeerTombstones` appears that this file does not name.
 *
 * Database `b81tC_planted`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/a-planted-tombstone-blocks-no-create-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';
import { build, peerToken, ADMIN_TOKEN } from './_push-door.mjs';

const skip = await mongoSkipReason();

const seq = await import('../../server/dist/util/seq.js');
const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
const CEILING = seq.MAX_INGEST_SEQ;
const CAP = seq.MAX_INGEST_SEQ - seq.SEQ_CEILING_RESERVE; // VERSION_FLOOR_CAP

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const END1 = U(1), END2 = U(2);
const SELF = 'b81c-planted';
const EDGE_ID = edgeIdFor(END1, END2, 'knows');
const DOORS = ['peer POST', 'trusted relay', 'pull', 'repair re-read', 'upstream ground'];
/** The issuer spellings a planted tombstone carries; `undefined` is "no `instanceId` key". */
const ISSUERS = [
  { name: 'absent', value: undefined, blank: true },
  { name: "''", value: '', blank: true },
  { name: "' '", value: ' ', blank: true },
  { name: 'an unrelated instance', value: 'planting-peer', blank: false },
  { name: 'this instance', value: SELF, blank: false },
];
const planted = DOORS.flatMap(d => ISSUERS.map(i => `p-${d.replace(/\s/g, '').toLowerCase()}-${ISSUERS.indexOf(i)}`));
/** The planting peer of the 'upstream ground' door: its own id, so being a member of the subscriber's network changes nothing for the other doors' `planting-peer`. */
const PLANTING_PEER = 'planting-upstream';
const SPACES = ['b', 'c', 'quiet', 'relay', ...planted];
/** A subscriber's network: the planting peer is the PUBLISHER of the spaces the 'upstream ground' door uses, so a delivery from it is the upstream's. */
const UPSTREAM_NETWORK = {
  id: 'b81c-planted-upstream-net', label: 'Planted upstream network', type: 'pubsub', origin: 'joined', votes: [], votingDeadlineHours: 24,
  spaces: planted.filter(s => s.startsWith('p-upstreamground-')),
  members: [{ instanceId: PLANTING_PEER, label: 'Planting peer', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'pull' }],   // a member this instance PULLS from is its publisher (`networkRole`), so the upstream
};

describe('a planted tombstone blocks no create', { skip }, () => {
  let door, edges, apply, authority, appliedBy;
  const peerB = peerToken(SELF);

  before(async () => {
    door = await openB81cDoor({ name: 'planted', spaces: SPACES, instanceId: SELF, networks: [UPSTREAM_NETWORK] });
    edges = await import('../../server/dist/brain/edges.js');
    apply = await import('../../server/dist/sync/tombstone-apply.js');
    authority = await import('../../server/dist/sync/deletion-authority.js');
    for (const s of SPACES) {
      await door.coll(s, 'entities').insertMany([
        build.entity(s, END1, 1, { author: { instanceId: SELF, instanceLabel: 'Self' } }),
        build.entity(s, END2, 1, { author: { instanceId: SELF, instanceLabel: 'Self' } }),
      ]);
    }
    /**
     * The four doors, each handing one raw tombstone page to the apply as that door does. `peer POST` and `trusted relay` go through
     * the route; `pull` and `repair re-read` call the apply with the delivery and options their callers use.
     */
    appliedBy = {
      'peer POST': async (space, raws) => {
        const r = await door.push('/tombstones', { tombstones: raws }, { spaceId: space, token: peerToken('planting-peer') });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        return { refused: r.body.refused };
      },
      'trusted relay': async (space, raws) => {
        const r = await door.push('/tombstones', { tombstones: raws }, { spaceId: space, token: ADMIN_TOKEN });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        return { refused: r.body.refused };
      },
      'pull': async (space, raws) => {
        const out = await apply.applyPeerTombstones(space, raws, authority.deliveryOfMember(space, { instanceId: 'planting-peer' }), 'b81c pull');
        return { refused: out.refused.length };
      },
      // The upstream's delivery (`upstream: true`: the space is carried by a pub/sub network whose publisher is the planting peer): the ground a held record's
      // deletion is honoured on (D-14). The verdict for an ABSENT record does not read it, so a planted tombstone for a record nobody holds is stored or refused as on the
      // other doors, and what is asserted below (never `issuedHere`, never lifts V, never blocks a create) holds on this door too.
      'upstream ground': async (space, raws) => {
        const delivery = authority.deliveryOfMember(space, { instanceId: PLANTING_PEER });
        assert.equal(delivery.upstream, true, 'the fixture does not make the planting peer the upstream of the space: this door would prove nothing');
        const out = await apply.applyPeerTombstones(space, raws, delivery, 'b81c upstream');
        return { refused: out.refused.length };
      },
      'repair re-read': async (space, raws) => {
        const out = await apply.applyPeerTombstones(space, raws, authority.deliveryOfMember(space, { instanceId: 'planting-peer' }), 'b81c re-read', { repair: true });
        return { refused: out.refused.length };
      },
    };
  });
  after(async () => { await door?.close(); });

  const plant = (space, issuer, at = CEILING) => ({
    _id: EDGE_ID, type: 'edge', spaceId: space, deletedAt: '2026-09-01T00:00:00.000Z', seq: at,
    ...(issuer.value === undefined ? {} : { instanceId: issuer.value }),
  });

  describe('the derivation', () => {
    it('every caller of applyPeerTombstones in server/src is a door this file names (a floor, so an empty listing cannot pass)', () => {
      const out = execFileSync('git', ['grep', '-l', '-E', 'applyPeerTombstones\\(', '--', 'server/src'], { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
        .trim().split('\n').map(f => f.replace(/\\/g, '/'));
      const callers = out.filter(f => f !== 'server/src/sync/tombstone-apply.ts');
      assert.ok(callers.length >= 2, `only ${callers.length} caller(s) found: ${callers}`);
      const named = new Set(['server/src/api/sync/tombstones.ts', 'server/src/sync/tombstone-transfer.ts']);
      const unnamed = callers.filter(f => !named.has(f));
      assert.deepEqual(unnamed, [], 'a new door applies tombstones: add it to DOORS here, or say why it is not one');
    });
  });

  describe('A and B: a re-create is never refused for a deletion', () => {
    it('A: B deletes content-id edge E, prunes the tombstone and re-creates it; a real receiver still holding the tombstone accepts it', async () => {
      const first = await edges.upsertEdge('b', END1, END2, 'knows');
      assert.equal(first._id ?? first.id, EDGE_ID);
      const row1 = await door.coll('b', 'edges').findOne({ _id: EDGE_ID });
      assert.equal((await door.push('/edges', { ...row1, spaceId: 'c' }, { spaceId: 'c', token: peerB })).code, 200);
      assert.equal(await edges.deleteEdge('b', EDGE_ID), true);
      const tomb = await door.coll('b', 'tombstones').findOne({ _id: EDGE_ID });
      assert.ok(tomb, 'the delete wrote no tombstone');
      const { storedVia, ...wire } = tomb;
      void storedVia;
      assert.equal((await door.push('/tombstones', { tombstones: [{ ...wire, spaceId: 'c' }] }, { spaceId: 'c', token: peerB })).code, 200);
      assert.ok(await door.coll('c', 'tombstones').findOne({ _id: EDGE_ID }), 'the receiver does not hold the tombstone');
      assert.equal(await door.coll('c', 'edges').countDocuments({ _id: EDGE_ID }), 0, 'the receiver kept the deleted edge');
      await door.coll('b', 'tombstones').deleteOne({ _id: EDGE_ID }); // B prunes it
      await edges.upsertEdge('b', END1, END2, 'knows');
      const row2 = await door.coll('b', 'edges').findOne({ _id: EDGE_ID });
      assert.ok(row2.seq > tomb.seq, `the re-create (seq ${row2.seq}) is not above the deletion it replaces (${tomb.seq})`);
      const sent = await door.push('/edges', { ...row2, spaceId: 'c' }, { spaceId: 'c', token: peerB });
      assert.equal(sent.code, 200, JSON.stringify(sent.body));
      assert.equal((await door.coll('c', 'edges').findOne({ _id: EDGE_ID }))?.seq, row2.seq, 'the receiver holding the tombstone refused the re-create');
    });

    it('B: QUIET B re-creates an edge A deleted at a high seq, above the deletion, without raising V; a relay holding the tombstone accepts it', async () => {
      const HIGH = 1_000_000;
      const aTomb = { _id: EDGE_ID, type: 'edge', spaceId: 'quiet', deletedAt: '2026-09-01T00:00:00.000Z', instanceId: 'peer-a', seq: HIGH };
      for (const [space, tok] of [['quiet', peerToken('peer-a')], ['relay', peerToken('peer-a')]]) {
        const r = await door.push('/tombstones', { tombstones: [{ ...aTomb, spaceId: space }] }, { spaceId: space, token: tok });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.ok(await door.coll(space, 'tombstones').findOne({ _id: EDGE_ID }), `${space} did not store A's tombstone`);
      }
      await edges.upsertEdge('quiet', END1, END2, 'knows');
      const row = await door.coll('quiet', 'edges').findOne({ _id: EDGE_ID });
      assert.ok(row.seq > HIGH, `B's re-create is stamped ${row.seq}, at or below A's deletion (${HIGH}): a relay holding the tombstone refuses it`);
      assert.ok(await door.counter('quiet') < HIGH,
        'the counter V was lifted to the deletion by an ARRIVAL: the stamp must count held tombstones itself and leave V alone');
      const sent = await door.push('/edges', { ...row, spaceId: 'relay' }, { spaceId: 'relay', token: peerToken(SELF) });
      assert.equal(sent.code, 200, JSON.stringify(sent.body));
      assert.equal((await door.coll('relay', 'edges').findOne({ _id: EDGE_ID }))?.seq, row.seq, 'the relay refused the re-create');
    });
  });

  describe('C: a tombstone planted at MAX_INGEST_SEQ, through every door', () => {
    for (const d of DOORS) {
      for (const [i, issuer] of ISSUERS.entries()) {
        const space = `p-${d.replace(/\s/g, '').toLowerCase()}-${i}`;
        const name = `${d}, issuer ${issuer.name}`;
        if (issuer.blank) {
          it(`${name}: refused alone, nothing stored`, async () => {
            const out = await appliedBy[d](space, [plant(space, issuer)]);
            assert.equal(out.refused, 1, `the blank issuer was not refused`);
            assert.equal(await door.coll(space, 'tombstones').countDocuments({ _id: EDGE_ID }), 0,
              'a tombstone with no usable issuer was stored: the codebase reads an empty issuer as "issuer-less", which governs every author');
          });
        } else {
          it(`${name}: stored but never issuedHere, never lifts V, and the create of that edge is written at most VERSION_FLOOR_CAP + 1`, async () => {
            const out = await appliedBy[d](space, [plant(space, issuer)]);
            assert.equal(out.refused, 0);
            const row = await door.coll(space, 'tombstones').findOne({ _id: EDGE_ID });
            assert.ok(row, 'the page stored nothing');
            assert.notEqual(row.issuedHere, true, 'a planted tombstone was stored as issued here');
            assert.ok(await door.counter(space) <= CAP,
              `the planted tombstone lifted V to ${await door.counter(space)}, above VERSION_FLOOR_CAP (${CAP})`);
            await edges.upsertEdge(space, END1, END2, 'knows');
            const created = await door.coll(space, 'edges').findOne({ _id: EDGE_ID });
            assert.ok(created, 'the create of the planted id was not written');
            assert.ok(created.seq <= CAP + 1,
              `the create was stamped ${created.seq}: more than VERSION_FLOOR_CAP + 1 (${CAP + 1}), so a planted tombstone raised a record's stamp past the cap`);
            assert.ok(await door.counter(space) <= CAP, 'the create moved V above VERSION_FLOOR_CAP');
          });
        }
      }
    }

    it('none is issued here and none is pushed on the mesh: sync/issued-here answers false for every planted row and true for a local delete', async () => {
      const mod = await moduleOrNull('sync/issued-here.js');
      assert.ok(mod, 'sync/issued-here.js is missing: "issued here" is a local mark with one module (rev 8 §6e)');
      assert.equal(typeof mod.isIssuedHere, 'function');
      assert.equal(typeof mod.issuedHereFilter, 'function');
      const mine = await door.coll('b', 'tombstones').find({}).toArray();
      await edges.upsertEdge('b', END1, END2, 'knows');
      await edges.deleteEdge('b', EDGE_ID);
      const local = await door.coll('b', 'tombstones').findOne({ _id: EDGE_ID });
      void mine;
      assert.equal(mod.isIssuedHere(local), true, 'a tombstone this instance issued is not marked');
      for (const space of planted) {
        for (const row of await door.coll(space, 'tombstones').find({}).toArray()) {
          assert.equal(mod.isIssuedHere(row), false, `a tombstone stored from a peer in ${space} reads as issued here`);
        }
      }
    });
  });
});
