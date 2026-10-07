/**
 * On a directional network a tombstone from this instance's DIRECT UPSTREAM deletes a record that ARRIVED from that
 * upstream, whoever wrote it — and nothing else (bundle-51, owner decision D-14 = C, 2026-10-07).
 *
 * ## The rule, held on both doors (`POST /api/sync/tombstones` and the engine's pull) and across network types
 *
 * A peer's tombstone has always been applied on ONE ground: its issuer is the delivering peer AND wrote the record
 * (ground A, `tombstoneGoverns`). On a pub/sub or tree network that left a publisher unable to retire what it had
 * relayed from a third author: the subscriber declined the deletion, logged nothing a person reads, and the record
 * lived on there while the publisher's copy was gone (Q-353, Q-276). The second ground (B) is the owner's answer:
 *
 *   B: the delivering peer IS this instance's upstream for a network carrying the space, and the record's STORED
 *      `deliveredBy` — who delivered the version held here — is that peer.
 *
 * It is "any of A, B" and it is bounded on every side, and each bound is a row below:
 *
 *  - **Only the upstream.** The same stamp from a subscriber, a child, a club member or a stranger deletes nothing: the
 *    table runs every network type the config knows and expects what `upstreamOf` says, rather than a list of two.
 *  - **Only what it delivered.** A record this instance wrote, one a lateral writer delivered, one an admin pushed
 *    (stamp `''`) and one another peer delivered all survive the upstream's tombstone. The stamp is the only thing B reads.
 *  - **The issuer is not asked.** A relayed tombstone is issued by the original deleter; B reads the deliverer and the
 *    stamp, so a tombstone issued by the third author and delivered by the upstream applies.
 *  - **A stored tombstone is the receiver's to relay.** A tombstone applied on B is STORED, with `storedVia` (the
 *    upstream), so a middle node serves it on; and it does not refuse a later version of the record delivered by that
 *    same upstream (the upstream re-sending a version superseded its own deletion), while it still refuses the same
 *    version delivered by a lateral peer that did not write it.
 *  - **A peer's entity deletion un-labels its faces** (Q-395): `unlabelFacesForEntities` says every delete path shares
 *    it, and the two peer-applied ones did not run it.
 *  - **A decline is said.** The push answer counts `declined` (additive; absent when zero), and the two counters carry
 *    the ground an applied deletion stood on and the reason a declined one did not.
 *
 * ## How the table is built — derived, never listed
 *
 * The network types are read out of `types-networks.ts` (floor 5), and every type is run twice: the peer as this
 * instance's parent/publisher and the peer as something else. The expectation of each cell is the rule above, written
 * once as an oracle over (issuer, author, stored stamp, whether the peer is the upstream) — and the upstream is not
 * assumed from the type's name but asked of `upstreamOf` on the live config. Every scenario of a cell is one page, so a
 * decision that leaked from one element to its neighbour fails a row it did not name.
 *
 * ## Seen red
 *
 * On the base (abc4cc57) the rows where the upstream deletes a relayed record fail on the record that is still there,
 * the stored-tombstone row fails on a `tombstoned` where the record should land, the cascade rows leave the face labelled,
 * and the decline rows find no `declined` in the answer and no counters. The survive rows are PINS and are green: they
 * state what B must not widen.
 *
 * Run: node --test testing/standalone/a-tombstone-from-the-upstream-deletes-what-it-relayed-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { topologies as allTopologies, peerIsUpstream as peerIsUpstreamOf } from './_network-topologies.mjs';
import { build, peerToken, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, LATERAL } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tsup';
const THIRD = 'third-party-author';
const OTHER_PEER = 'another-peer';
const STRANGER_PARENT = 'some-other-parent';

let door, ME, upstreamOf, register;

/** Every network type twice, and whether the peer is the upstream is asked of the server (`_network-topologies.mjs`). */
const topologies = () => allTopologies(PEER, STRANGER_PARENT);
const peerIsUpstream = () => peerIsUpstreamOf(door, upstreamOf, PEER, S);

const fact = (id, seq, author, stamp, extra = {}) => {
  const d = build.fact(S, id, seq, extra);
  if (author === undefined) delete d.author; else d.author = { instanceId: author, instanceLabel: author };
  if (stamp !== undefined) d.deliveredBy = stamp;
  return d;
};
const tomb = (id, seq, issuer, type = 'fact') => build.tombstone(S, id, type, seq, { instanceId: issuer });
const stored = (part, id) => door.coll(S, part).findOne({ _id: id });

/** Deliver tombstones as the fake peer: by POST on the push door, or served by the fake peer to the engine's pull. */
const DOORS = {
  push: { async deliver(tombstones) { return door.push('/tombstones', { tombstones }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: { async deliver(tombstones) { await door.seedPeer(S, tombstones); return door.sync(); } },
};

/**
 * The scenarios. `author`/`stamp` are what the stored record carries (`undefined` = the field is absent), `issuer` is
 * who issued the tombstone. The oracle below is the whole rule.
 */
const SCENARIOS = [
  { id: 'relayed-third', note: 'a third party wrote it, the peer delivered it', author: THIRD, stamp: PEER, issuer: PEER },
  { id: 'relayed-issued-by-author', note: 'the same, the tombstone issued by the third author (a relayed deletion)', author: THIRD, stamp: PEER, issuer: THIRD },
  { id: 'peers-own', note: 'the peer wrote it and delivered it', author: PEER, stamp: PEER, issuer: PEER },
  { id: 'peers-own-stamped-elsewhere', note: 'the peer wrote it, another peer delivered this copy', author: PEER, stamp: OTHER_PEER, issuer: PEER },
  { id: 'lateral-writer', note: 'a lateral peer wrote and delivered it', author: LATERAL, stamp: LATERAL, issuer: PEER },
  { id: 'lateral-relayed-third', note: 'a third party wrote it, a lateral peer delivered it', author: THIRD, stamp: LATERAL, issuer: PEER },
  { id: 'admin-pushed', note: 'an admin pushed it: stamp is the empty string', author: THIRD, stamp: '', issuer: PEER },
  { id: 'other-peer', note: 'a third party wrote it, ANOTHER peer delivered it', author: THIRD, stamp: OTHER_PEER, issuer: PEER },
  { id: 'self-authored', note: 'this instance wrote it', author: 'ME', stamp: undefined, issuer: PEER },
  { id: 'unstamped-third', note: 'a third party wrote it and it carries no stamp', author: THIRD, stamp: undefined, issuer: PEER },
  { id: 'authorless-legacy', note: 'no author at all (a legacy row)', author: undefined, stamp: undefined, issuer: PEER },
  { id: 'empty-author-legacy', note: 'an empty author', author: '', stamp: undefined, issuer: PEER },
  { id: 'forged-issuer-unstamped', note: 'the issuer is a third party, nothing was delivered by the peer', author: THIRD, stamp: undefined, issuer: THIRD },
];

/** The rule, written once: A or B. Returns what a cell must show for a scenario. */
function oracle(s, upstream) {
  const author = s.author === 'ME' ? ME : s.author;
  const a = s.issuer === PEER && !(s.issuer && author && s.issuer !== author);
  const b = upstream && typeof s.stamp === 'string' && s.stamp !== '' && s.stamp === PEER;
  return { deleted: a || b, viaUpstream: !a && b };
}

describe('the upstream deletes what it relayed, and nothing else (D-14 = C)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsupstream', spaces: [S], lateral: true });
    ME = door.instanceId;
    ({ upstreamOf } = await import('../../server/dist/networks/network-spaces.js'));
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the table is derived: every network type, upstream and not, with a floor', () => {
    const all = topologies();
    assert.ok(all.length >= 10, `only ${all.length} topologies`);
    const ups = all.map(t => { door.configure(t.set); return peerIsUpstream(); });
    door.configure({ type: 'pubsub', myParentInstanceId: null, direction: 'pull' });
    assert.ok(ups.filter(Boolean).length >= 2, `the derivation found ${ups.filter(Boolean).length} topologies where the peer is the upstream; a pub/sub subscriber and a braintree child of it are two`);
    assert.ok(ups.filter(u => !u).length >= 5, 'too few topologies where the peer is not the upstream');
    assert.ok(SCENARIOS.length >= 12, 'the scenario table shrank');
  });

  for (const [doorName, d] of Object.entries(DOORS)) {
    describe(`${doorName} door: every network type, every scenario`, () => {
      for (const top of topologies()) {
        it(`${top.name}`, async () => {
          await door.reset();
          door.configure(top.set);
          const upstream = peerIsUpstream();
          for (const s of SCENARIOS) {
            const author = s.author === 'ME' ? ME : s.author;
            await door.coll(S, 'facts').insertOne(fact(s.id, 3, author, s.stamp));
          }
          // The absent-target control: a tombstone for a record this instance does not hold.
          const page = [...SCENARIOS.map((s, i) => tomb(s.id, 20 + i, s.issuer)), tomb('never-held', 50, PEER)];
          await d.deliver(page);

          const wrong = [];
          for (const s of SCENARIOS) {
            const want = oracle(s, upstream);
            const rec = await stored('facts', s.id);
            const t = await stored('tombstones', s.id);
            if ((rec === null) !== want.deleted) {
              wrong.push(`${s.id} (${s.note}): ${want.deleted ? 'the record is STILL HERE' : 'the record was DELETED'}`);
            }
            if ((t !== null) !== want.deleted) {
              wrong.push(`${s.id}: the tombstone was ${t !== null ? 'stored for a deletion that was refused' : 'not stored for a deletion that was applied'}`);
            }
            if (want.viaUpstream && t?.storedVia !== PEER) {
              wrong.push(`${s.id}: applied on the upstream ground but stored with storedVia ${JSON.stringify(t?.storedVia)}, want '${PEER}' (a middle node relays it)`);
            }
            if (!upstream && t && 'storedVia' in t) wrong.push(`${s.id}: a tombstone stored where the peer is no upstream carries storedVia '${t.storedVia}'`);
          }
          if ((await stored('tombstones', 'never-held')) === null) wrong.push('never-held: a tombstone for a record not held here was not stored (the control)');
          assert.deepEqual(wrong, [], `${doorName} / ${top.name} (peer is the upstream: ${upstream})`);
        });
      }
    });
  }

  describe('the stamp is set by the door that delivered the record, then the upstream retires it (end to end)', () => {
    /** Land a record by a door, then deliver the upstream's tombstone for it by `d`; return whether it is still here. */
    async function relayedThenDeleted(land, d) {
      await door.reset();
      await land();
      const here = await stored('facts', 'e2e');
      assert.ok(here, 'fixture: the record did not land');
      // The peer no longer serves the record (it deleted it): a canned page left in place would re-deliver it past the
      // tombstone, which is the upstream re-sending a version — a different row, below.
      door.state.records = {};
      await d.deliver([tomb('e2e', 90, THIRD)]);
      return (await stored('facts', 'e2e')) !== null;
    }
    const record = () => build.fact(S, 'e2e', 3, { author: { instanceId: THIRD, instanceLabel: THIRD } });
    const pushBy = (token) => () => door.push('/batch-upsert', { facts: [record()] }, { spaceId: S, token });
    const pulledFromPeer = async () => { door.state.records[S] = { facts: [record()] }; await door.sync(); };

    for (const [doorName, d] of Object.entries(DOORS)) {
      it(`${doorName}: what the UPSTREAM pushed is deleted by the upstream's tombstone`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(peerToken(PEER)), d), false,
          'a record the upstream pushed (a third author\'s) survived the upstream\'s own tombstone — the deletion was declined');
      });
      it(`${doorName}: what the UPSTREAM served to this instance's pull is deleted by the upstream's tombstone`, async () => {
        assert.equal(await relayedThenDeleted(pulledFromPeer, d), false, 'a pulled record survived the upstream\'s tombstone');
      });
      it(`${doorName}: what an ADMIN pushed survives it`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(ADMIN_TOKEN), d), true, 'an admin-pushed record was deleted by the upstream');
      });
      it(`${doorName}: what a LATERAL peer pushed survives it`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(peerToken(LATERAL)), d), true, 'a lateral peer\'s record was deleted by the upstream');
      });
      it(`${doorName}: what ANOTHER peer pushed survives it`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(peerToken(OTHER_PEER)), d), true, 'a record another peer delivered was deleted by the upstream');
      });
    }
  });

  describe('a tombstone stored under the upstream ground', () => {
    // Held as an earlier B-apply left it: issued by the third author, stored via the upstream.
    const heldViaUpstream = (id) => ({ ...tomb(id, 20, THIRD), storedVia: PEER });
    const heldPlain = (id) => tomb(id, 20, THIRD);
    const later = (id) => build.fact(S, id, 10, { author: { instanceId: THIRD, instanceLabel: THIRD } });

    it('push: does not refuse a later version of the record delivered by that same upstream', async () => {
      await door.coll(S, 'tombstones').insertOne(heldViaUpstream('late-push'));
      const r = await door.push('/batch-upsert', { facts: [later('late-push')] }, { spaceId: S, token: peerToken(PEER) });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(r.body.facts.inserted, 1,
        `the upstream's own later version was refused by the tombstone the upstream sent: ${JSON.stringify(r.body.facts)}`);
      assert.ok(await stored('facts', 'late-push'), 'the later version did not land');
    });

    it('pull: does not refuse a later version of the record served by that same upstream', async () => {
      await door.coll(S, 'tombstones').insertOne(heldViaUpstream('late-pull'));
      door.state.records[S] = { facts: [later('late-pull')] };
      await door.sync();
      assert.ok(await stored('facts', 'late-pull'),
        'the upstream\'s own later version was refused by the tombstone the upstream sent');
    });

    it('PIN push: still refuses the same version delivered by a LATERAL peer that did not write it', async () => {
      await door.coll(S, 'tombstones').insertOne(heldViaUpstream('late-lateral'));
      const r = await door.push('/batch-upsert', { facts: [later('late-lateral')] }, { spaceId: S, token: peerToken(LATERAL) });
      assert.equal(r.body.facts.tombstoned, 1, `a lateral peer's copy of a record the upstream deleted landed: ${JSON.stringify(r.body.facts)}`);
      assert.equal(await stored('facts', 'late-lateral'), null);
    });

    it('PIN push: a tombstone NOT stored via the upstream still refuses the upstream\'s later version of an author\'s record', async () => {
      await door.coll(S, 'tombstones').insertOne(heldPlain('late-plain'));
      const r = await door.push('/batch-upsert', { facts: [later('late-plain')] }, { spaceId: S, token: peerToken(PEER) });
      assert.equal(r.body.facts.tombstoned, 1, `the exception reached a tombstone that was never stored via the upstream: ${JSON.stringify(r.body.facts)}`);
    });

    it('PIN pull: the same, for a tombstone not stored via the upstream', async () => {
      await door.coll(S, 'tombstones').insertOne(heldPlain('late-plain-pull'));
      door.state.records[S] = { facts: [later('late-plain-pull')] };
      await door.sync();
      assert.equal(await stored('facts', 'late-plain-pull'), null, 'the exception reached a tombstone that was never stored via the upstream');
    });
  });

  describe('Q-395: an entity a peer tombstone deletes has its face labels removed, on both doors and both grounds', () => {
    const GROUNDS = [
      { name: 'ground A (the peer wrote it)', author: PEER, stamp: undefined, issuer: PEER },
      { name: 'ground B (the upstream relayed it)', author: THIRD, stamp: PEER, issuer: THIRD },
    ];
    for (const [doorName, d] of Object.entries(DOORS)) {
      for (const g of GROUNDS) {
        it(`${doorName}, ${g.name}`, async () => {
          const ent = build.entity(S, 'ent-face', 3, { author: { instanceId: g.author, instanceLabel: g.author } });
          if (g.stamp !== undefined) ent.deliveredBy = g.stamp;
          await door.coll(S, 'entities').insertMany([ent, build.entity(S, 'ent-kept', 4, { author: { instanceId: PEER, instanceLabel: PEER } })]);
          // Face records are file metadata rows (`{fileId}#face-chunk{N}`) carrying the label.
          await door.coll(S, 'files').insertMany([
            build.filemeta(S, 'photo.jpg#face-chunk0', 5, { faceEntityId: 'ent-face', faceScore: 0.91 }),
            build.filemeta(S, 'photo.jpg#face-chunk1', 6, { faceEntityId: 'ent-kept', faceScore: 0.88 }),
          ]);
          await d.deliver([tomb('ent-face', 60, g.issuer, 'entity')]);
          assert.equal(await stored('entities', 'ent-face'), null, 'fixture: the entity was not deleted, so the cascade is not reached');
          const face = await stored('files', 'photo.jpg#face-chunk0');
          assert.ok(face, 'the face record itself must stay (the photo is the operator\'s): it is un-labelled, never deleted');
          assert.deepEqual([face.faceEntityId, face.faceScore], [undefined, undefined],
            'the face still names the entity this instance just deleted for a peer — the biometric label outlived its person');
          assert.equal((await stored('files', 'photo.jpg#face-chunk1')).faceEntityId, 'ent-kept', 'another entity\'s face label was removed');
        });
      }
    }
  });

  describe('a decline is said: the answer and the counters', () => {
    /** The sum of a counter's series whose labels match `where`, over every other label. */
    async function counter(name, where) {
      const m = (await register.getMetricsAsJSON()).find(x => x.name === name);
      assert.ok(m, `${name} is not registered — pre-declared at zero so its HELP/TYPE lines exist from startup`);
      return m.values.filter(v => Object.entries(where).every(([k, val]) => v.labels[k] === val)).reduce((a, v) => a + v.value, 0);
    }

    it('the two counters exist before anything is applied', async () => {
      await counter('ythril_sync_tombstones_applied_total', {});
      await counter('ythril_sync_tombstones_declined_total', {});
    });

    it('push: a declined element is COUNTED in the answer; `declined` is absent when nothing was declined', async () => {
      await door.coll(S, 'facts').insertMany([fact('d-ok', 3, PEER, undefined), fact('d-no', 3, THIRD, OTHER_PEER)]);
      const mixed = await door.push('/tombstones', { tombstones: [tomb('d-ok', 30, PEER), tomb('d-no', 31, PEER)] },
        { spaceId: S, token: peerToken(PEER) });
      assert.deepEqual([mixed.code, mixed.body], [200, { applied: 2, refused: 0, declined: 1 }],
        'a tombstone the receiver declined on authority is answered as if it had landed, and the sender prunes it believing so');
      const clean = await door.push('/tombstones', { tombstones: [tomb('never-held', 32, PEER)] }, { spaceId: S, token: peerToken(PEER) });
      assert.deepEqual(clean.body, { applied: 1, refused: 0 }, 'an absent target is applied-nothing and is never counted as declined');
    });

    it('applied is counted by the ground it stood on, and declined by the reason it did not', async () => {
      const applied = (ground) => counter('ythril_sync_tombstones_applied_total', { ground });
      const declined = (reason) => counter('ythril_sync_tombstones_declined_total', { reason });
      const before = { issuer: await applied('issuer'), upstream: await applied('upstream'),
        notIssuer: await declined('not_issuer'), notAuthor: await declined('not_author'), notUpstream: await declined('not_upstream') };

      // The peer IS the upstream here: one deletion on each ground, and one declined because the stamp is another peer's.
      await door.coll(S, 'facts').insertMany([fact('m-a', 3, PEER, undefined), fact('m-b', 3, THIRD, PEER), fact('m-n', 3, THIRD, OTHER_PEER)]);
      await door.push('/tombstones', { tombstones: [tomb('m-a', 40, PEER), tomb('m-b', 41, THIRD), tomb('m-n', 42, THIRD)] },
        { spaceId: S, token: peerToken(PEER) });
      // The peer is NOT the upstream: the issuer proof holds and authorship fails (not_author); the issuer is not the deliverer (not_issuer).
      door.configure({ type: 'club', direction: 'both' });
      await door.coll(S, 'facts').insertMany([fact('m-c', 3, THIRD, PEER), fact('m-d', 3, THIRD, PEER)]);
      await door.push('/tombstones', { tombstones: [tomb('m-c', 43, PEER), tomb('m-d', 44, 'a-forged-issuer')] },
        { spaceId: S, token: peerToken(PEER) });

      assert.deepEqual({
        issuer: await applied('issuer') - before.issuer, upstream: await applied('upstream') - before.upstream,
        notUpstream: await declined('not_upstream') - before.notUpstream, notAuthor: await declined('not_author') - before.notAuthor,
        notIssuer: await declined('not_issuer') - before.notIssuer,
      }, { issuer: 1, upstream: 1, notUpstream: 1, notAuthor: 1, notIssuer: 1 });
    });
  });
});
