/**
 * The predicate a peer-applied delete CARRIES is the verdict the apply read, and a verdict that went stale between the
 * read and the write deletes nothing (bundle-51, `sync/deletion-authority.ts`).
 *
 * ## The rule
 *
 * `authorises` decides from a READ of the target; the delete is a later WRITE. Between them another delivery can replace
 * the record — a newer copy from another peer (its stamp is no longer the upstream's), an edit that moved its author — so
 * a verdict that was true when read is not true when written. The old apply carried a bound for this on the one ground it
 * had (`author.instanceId ∈ {issuer, null, ''}`, "a record another author wrote between the read and this write is not
 * taken with it"). Two grounds need two bounds, and `deleteBound(ground, …)` is the one place each is spelled: the delete
 * carries the predicate of the ground that authorised it, so the write re-checks the verdict instead of trusting it.
 * The upstream's bound is `{ deliveredBy: deliverer, 'author.instanceId': { $ne: selfId } }`: the verdict's rule that the
 * upstream ground never reaches a record THIS instance wrote is re-checked in the write too, so a record that became
 * this instance's own between the read and the write is not taken with it.
 *
 * ## What is asserted, on seeded Mongo
 *
 *  1. **Outcome = verdict**, over the whole table: every network type (derived, `_network-topologies.mjs`) x every way a
 *     peer can deliver (as the upstream, as another peer, as an admin's trusted relay, with no identity) x issuer x every
 *     target the table can hold (this instance's own, the peer's, a third party's, a lateral writer's, author-less,
 *     empty-author; stamped by this deliverer, by another peer, with `''`, unstamped) plus an absent target. The verdict is
 *     asked of `authorises` over a delivery built by `deliveryOf` from the LIVE config; the delete is the ground's own
 *     `deleteBound` in a `deleteMany` over the ids that ground authorised. What is gone afterwards is exactly what the
 *     verdict said — no more, and every authorised target — and an absent target has nothing to delete.
 *  2. **A stale verdict deletes nothing** (the race rows): the stamp changed to another peer's, the author moved to a third
 *     party's, or to THIS instance (the self-exclusion), between the read and the write; the delete finds no record
 *     under its bound and the replacement survives. And the control: the same delete with nothing changed deletes.
 *     Also in the table: every cell where the delivering upstream's stamp sits on a record this instance wrote must
 *     leave it standing (floored, so the cells cannot all be ones where the stamp was someone else's).
 *
 * ## Seen red
 *
 * The module `sync/deletion-authority.ts` does not exist at the base (abc4cc57): the file fails on the import. That is the
 * acceptable red for the table of a NEW module; the doors that use it are held by
 * `a-tombstone-from-the-upstream-deletes-what-it-relayed-db` on behaviour.
 *
 * Run: node --test testing/standalone/the-deletion-authority-bound-is-the-verdict-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { topologies, peerIsUpstream } from './_network-topologies.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, LATERAL } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tsauth';
const THIRD = 'third-party-author';
const OTHER = 'another-peer';
const STRANGER = 'a-stranger-peer';

let door, ME, authority, upstreamOf;

/** How a delivery reaches `deliveryOf`: the auth the two doors hand it. */
const AUTHS = [
  { name: 'the peer', auth: { peerInstanceId: PEER } },
  { name: 'another peer', auth: { peerInstanceId: STRANGER } },
  { name: 'an admin\'s trusted relay', auth: { trustedRelay: true } },
  { name: 'no identity at all', auth: {} },
];
const ISSUERS = [PEER, THIRD, STRANGER];
const AUTHORS = ['ME', PEER, THIRD, LATERAL, undefined, ''];
const STAMPS = [PEER, OTHER, '', undefined];

const label = (v) => (v === undefined ? 'none' : v === '' ? 'empty' : v);
const tag = (author, stamp) => `a-${label(author)}-s-${label(stamp)}`;

/** One seeded fact per (author, stamp), every combination, ids derived from them. */
function targets() {
  const out = [];
  for (const author of AUTHORS) for (const stamp of STAMPS) {
    const real = author === 'ME' ? ME : author;
    const d = build.fact(S, tag(author, stamp), 3);
    if (real === undefined) delete d.author; else d.author = { instanceId: real, instanceLabel: String(real) };
    if (stamp !== undefined) d.deliveredBy = stamp;
    out.push({ id: d._id, doc: d, author: real, stamp });
  }
  return out;
}

describe('the delete carries the verdict, and a stale verdict deletes nothing', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsauth', spaces: [S], lateral: true });
    ME = door.instanceId;
    ({ upstreamOf } = await import('../../server/dist/networks/network-spaces.js'));
    authority = await import('../../server/dist/sync/deletion-authority.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the table is derived: topologies, deliveries, issuers and targets, with floors', () => {
    assert.ok(topologies(PEER).length >= 10, 'too few topologies');
    assert.ok(AUTHS.length * ISSUERS.length * targets().length >= 250, 'the verdict table shrank');
    for (const f of ['deliveryOf', 'authorises', 'deleteBound']) assert.equal(typeof authority[f], 'function', `deletion-authority.${f} is not exported`);
  });

  it('outcome = verdict: what is gone is exactly what the verdict authorised, for every cell', async () => {
    const facts = door.coll(S, 'facts');
    const wrong = [];
    let cells = 0;
    let deletions = 0;
    let selfStampedByUpstream = 0;
    for (const top of topologies(PEER)) {
      door.configure(top.set);
      const upstream = peerIsUpstream(door, upstreamOf, PEER, S);
      for (const { name: how, auth } of AUTHS) {
        const delivery = authority.deliveryOf(door.config(), S, auth);
        const wantUpstream = upstream && auth.peerInstanceId === PEER;
        if (delivery.upstream !== wantUpstream) wrong.push(`${top.name} / ${how}: deliveryOf says upstream=${delivery.upstream}, the config says ${wantUpstream}`);
        if (delivery.trustedRelay !== (auth.trustedRelay === true)) wrong.push(`${top.name} / ${how}: deliveryOf says trustedRelay=${delivery.trustedRelay}`);
        for (const issuer of ISSUERS) {
          cells++;
          await facts.deleteMany({});
          const seeded = targets();
          await facts.insertMany(seeded.map(t => ({ ...t.doc })));
          const held = new Map((await facts.find({}).toArray()).map(d => [d._id, d]));
          const verdicts = new Map(seeded.map(t => [t.id, authority.authorises(delivery, issuer, held.get(t.id), ME)]));

          // The delete the apply makes: one per ground, over the ids that ground authorised, carrying that ground's bound.
          for (const ground of ['issuer', 'upstream']) {
            const ids = seeded.filter(t => { const v = verdicts.get(t.id); return v.ok && v.ground === ground; }).map(t => t.id);
            if (ids.length === 0) continue;
            await facts.deleteMany({ _id: { $in: ids }, ...authority.deleteBound(ground, { issuer, deliverer: auth.peerInstanceId, selfId: ME }) });
          }
          const left = new Set((await facts.find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
          for (const t of seeded) {
            const v = verdicts.get(t.id);
            const shouldGo = v.ok && (v.ground === 'issuer' || v.ground === 'upstream');
            if (shouldGo) deletions++;
            // The amended D-14 rule: a record THIS instance wrote is never the upstream's to delete, stamped or not.
            // Counted only where the deliverer really is the stamped upstream, so the floor below cannot be met by cells
            // where the stamp was never the deliverer's.
            if (delivery.upstream && t.author === ME && t.stamp === auth.peerInstanceId) {
              selfStampedByUpstream++;
              if (!left.has(t.id)) wrong.push(`${top.name} / ${how} / issuer ${label(issuer)}: a record THIS instance wrote and the upstream stamped was deleted`);
            }
            if (left.has(t.id) === shouldGo) {
              wrong.push(`${top.name} / ${how} / issuer ${label(issuer)} / author ${label(t.author)} stamp ${label(t.stamp)}: `
                + `verdict ${JSON.stringify(v)} but the record is ${left.has(t.id) ? 'STILL THERE' : 'GONE'}`);
            }
          }
          // An absent target: the verdict is an applied-nothing, and there is nothing for a delete to take.
          const absent = authority.authorises(delivery, issuer, null, ME);
          if (!(absent.ok === true && absent.ground === 'absent')) wrong.push(`${top.name} / ${how} / issuer ${label(issuer)}: an absent target answered ${JSON.stringify(absent)}`);
        }
      }
    }
    assert.ok(cells >= 100, `only ${cells} cells ran`);
    assert.ok(deletions >= 100, `only ${deletions} deletions in the whole table: the verdict never authorised enough for the equality to mean anything`);
    assert.ok(selfStampedByUpstream >= 6, `only ${selfStampedByUpstream} cells held a self-authored record stamped by the delivering upstream: the self-exclusion was never exercised`);
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} cell(s) disagree between the verdict and what the delete did`);
  });

  describe('a stale verdict deletes nothing', () => {
    const peerDelivery = () => authority.deliveryOf(door.config(), S, { peerInstanceId: PEER });
    const deleteUnder = async (verdict, issuer, id) => (await door.coll(S, 'facts').deleteMany({
      _id: id, ...authority.deleteBound(verdict.ground, { issuer, deliverer: PEER, selfId: ME }),
    })).deletedCount;

    it('upstream ground: the record was replaced by another peer\'s copy between the read and the write', async () => {
      const facts = door.coll(S, 'facts');
      await facts.insertOne({ ...build.fact(S, 'race-up', 3, { author: { instanceId: THIRD, instanceLabel: THIRD } }), deliveredBy: PEER });
      const verdict = authority.authorises(peerDelivery(), THIRD, await facts.findOne({ _id: 'race-up' }), ME);
      assert.deepEqual(verdict, { ok: true, ground: 'upstream' }, 'fixture: the read verdict is not the upstream ground');
      await facts.updateOne({ _id: 'race-up' }, { $set: { deliveredBy: OTHER, seq: 4 } });   // a newer delivery landed
      assert.equal(await deleteUnder(verdict, THIRD, 'race-up'), 0, 'the upstream\'s delete took a record another peer had since delivered');
      assert.ok(await facts.findOne({ _id: 'race-up' }), 'the replacement was deleted');
    });

    it('upstream ground: the record became this instance\'s own (an edit here) between the read and the write', async () => {
      const facts = door.coll(S, 'facts');
      await facts.insertOne({ ...build.fact(S, 'race-self', 3, { author: { instanceId: THIRD, instanceLabel: THIRD } }), deliveredBy: PEER });
      const verdict = authority.authorises(peerDelivery(), THIRD, await facts.findOne({ _id: 'race-self' }), ME);
      assert.deepEqual(verdict, { ok: true, ground: 'upstream' }, 'fixture: the read verdict is not the upstream ground');
      // The stamp is still the upstream's; only the author changed, which is the half of the write the self-exclusion guards.
      await facts.updateOne({ _id: 'race-self' }, { $set: { 'author.instanceId': ME } });
      assert.equal(await deleteUnder(verdict, THIRD, 'race-self'), 0, 'the upstream\'s delete took a record this instance has since come to author');
      assert.ok(await facts.findOne({ _id: 'race-self' }), 'the self-authored record was deleted');
    });

    it('upstream ground: a self-authored record carrying the upstream\'s stamp is outside the bound outright', async () => {
      const facts = door.coll(S, 'facts');
      await facts.insertOne({ ...build.fact(S, 'self-stamped', 3, { author: { instanceId: ME, instanceLabel: ME } }), deliveredBy: PEER });
      assert.equal(await deleteUnder({ ok: true, ground: 'upstream' }, THIRD, 'self-stamped'), 0,
        'the upstream ground\'s own bound reached a record this instance wrote');
      assert.ok(await facts.findOne({ _id: 'self-stamped' }));
    });

    it('issuer ground: the record\'s author moved to a third party between the read and the write', async () => {
      const facts = door.coll(S, 'facts');
      await facts.insertOne(build.fact(S, 'race-issuer', 3, { author: { instanceId: PEER, instanceLabel: PEER } }));
      const verdict = authority.authorises(peerDelivery(), PEER, await facts.findOne({ _id: 'race-issuer' }), ME);
      assert.deepEqual(verdict, { ok: true, ground: 'issuer' }, 'fixture: the read verdict is not the issuer ground');
      await facts.updateOne({ _id: 'race-issuer' }, { $set: { 'author.instanceId': THIRD } });
      assert.equal(await deleteUnder(verdict, PEER, 'race-issuer'), 0, 'the issuer\'s delete took a record another author now owns');
    });

    it('the control: with nothing changed, each ground\'s delete deletes', async () => {
      const facts = door.coll(S, 'facts');
      await facts.insertMany([
        { ...build.fact(S, 'ctl-up', 3, { author: { instanceId: THIRD, instanceLabel: THIRD } }), deliveredBy: PEER },
        build.fact(S, 'ctl-issuer', 3, { author: { instanceId: PEER, instanceLabel: PEER } }),
      ]);
      const up = authority.authorises(peerDelivery(), THIRD, await facts.findOne({ _id: 'ctl-up' }), ME);
      const iss = authority.authorises(peerDelivery(), PEER, await facts.findOne({ _id: 'ctl-issuer' }), ME);
      assert.equal(await deleteUnder(up, THIRD, 'ctl-up'), 1);
      assert.equal(await deleteUnder(iss, PEER, 'ctl-issuer'), 1);
    });
  });
});
