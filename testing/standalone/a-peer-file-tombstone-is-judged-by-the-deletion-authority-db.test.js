/**
 * A file tombstone a peer delivers is judged by the SAME deletion authority as a record tombstone, on both doors, over
 * every network type (bundle-51 Q-242, D-14 = C).
 *
 * ## The defect it holds shut
 *
 * `POST /api/sync/file-tombstones` and the pull's tombstone step each deleted the file a peer's tombstone NAMED, with no
 * question asked of who the peer is: any peer able to push to a space could erase any file in it, and the pull deleted the
 * file's bytes and row for a deliverer whose tombstone no record door would have honoured. A record tombstone has always
 * needed its issuer to be the delivering peer AND the author of what it deletes (ground A); bundle-51 adds the owner's second
 * ground (B): on a directional network the tombstone of this instance's UPSTREAM deletes what that upstream delivered,
 * whoever wrote it. A file is a record of this kind, so the rule is one rule (`sync/deletion-authority.ts`), not a second
 * copy that is looser.
 *
 * ## The rule, written once as an oracle and run over the whole table
 *
 *   deleted  =  A  or  B
 *   A (issuer proof):  the issuer is the delivering peer, and the issuer wrote the file (or the file names no author)
 *   B (upstream):      the delivering peer is this instance's upstream, the file row's stored `deliveredBy` is that peer,
 *                      and the file is not this instance's own
 *
 * The network types are read out of `NetworkType`'s declaration (floor 5), each run twice (the peer as the parent/publisher,
 * and as anything else), and whether the peer IS the upstream is asked of the server's own `upstreamOf` on the live config —
 * never inferred from a name. Every scenario of a cell is one page, so a verdict that leaked from one element to its
 * neighbour fails a row it did not name.
 *
 * What a cell must show, per scenario: the bytes and the file row are gone exactly when the oracle says so; the tombstone is
 * STORED exactly when it was applied (the space is served onward in every cell — a lateral club member carries it); a
 * declined one is counted (the push answer's `declined`, and the declined counter either way); an applied one is counted
 * by the ground it stood on.
 *
 * ## Seen red
 *
 * On the base every survive row fails on a file that was deleted for a peer with no claim on it, and the decline rows find
 * no `declined` in the answer and no counter. The applied rows are green: they state what the rule must still allow.
 *
 * Run: node --test testing/standalone/a-peer-file-tombstone-is-judged-by-the-deletion-authority-db.test.js
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

const S = 'ftau';
const THIRD = 'third-party-author';
const OTHER_PEER = 'another-peer';
const STRANGER_PARENT = 'some-other-parent';

let door, ME, upstreamOf, register;

const topologies = () => allTopologies(PEER, STRANGER_PARENT);
const peerIsUpstream = () => peerIsUpstreamOf(door, upstreamOf, PEER, S);

const pathOf = (id) => `${id}.txt`;
const stored = (part, id) => door.coll(S, part).findOne({ _id: id });
const onDisk = (id) => door.localFileExists(S, pathOf(id));

/** One file here: its bytes, and a row naming the author and who delivered this version (`undefined` = the field is absent). */
async function seedFile(id, author, stamp, seq = 3) {
  door.writeLocalFile(S, pathOf(id), `bytes of ${id}`);
  const row = build.filemeta(S, pathOf(id), seq, { sizeBytes: 11 });
  if (author === undefined) delete row.author; else row.author = { instanceId: author, instanceLabel: author };
  if (stamp !== undefined) row.deliveredBy = stamp;
  await door.coll(S, 'files').insertOne(row);
}

/** The wire tombstone for a scenario's file. Each is at its own position. */
const tombFor = (id, issuer, n) => ({ _id: `ft-${id}`, spaceId: S, path: pathOf(id), deletedAt: `2026-09-01T00:00:${String(n).padStart(2, '0')}.000Z`, issuer, rowSeq: 3 });

/** Deliver tombstones as the fake peer: by POST on the push door, or served by the fake peer to the engine's pull. */
const DOORS = {
  push: { async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
  },
};

/** What the stored file row and the file's own author are, per scenario. `author`/`stamp` are what the row carries. */
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
  { id: 'self-authored-stamped', note: 'this instance wrote it, and the upstream is the stamp (never the upstream\'s to delete)', author: 'ME', stamp: PEER, issuer: PEER },
  { id: 'unstamped-third', note: 'a third party wrote it and it carries no stamp', author: THIRD, stamp: undefined, issuer: PEER },
  { id: 'authorless-legacy', note: 'no author at all (a legacy row)', author: undefined, stamp: undefined, issuer: PEER },
  { id: 'empty-author-legacy', note: 'an empty author', author: '', stamp: undefined, issuer: PEER },
  { id: 'forged-issuer-unstamped', note: 'the issuer is a third party, nothing was delivered by the peer', author: THIRD, stamp: undefined, issuer: THIRD },
];

/** The rule, written once: A or B. Returns what a cell must show for a scenario. */
function oracle(s, upstream) {
  const author = s.author === 'ME' ? ME : s.author;
  const a = s.issuer === PEER && !(s.issuer && author && s.issuer !== author);
  const b = upstream && typeof s.stamp === 'string' && s.stamp !== '' && s.stamp === PEER && author !== ME;
  return { deleted: a || b, viaUpstream: !a && b };
}

/** The sum of a counter's series whose labels match, over every other label; `kind` matches any label that names a file. */
async function counter(name, where = {}) {
  const m = (await register.getMetricsAsJSON()).find(x => x.name === name);
  assert.ok(m, `${name} is not registered — pre-declared at zero so its HELP/TYPE lines exist from startup`);
  return seriesSum(m, where);
}
/** `null` when the metric is not registered: a table cell judges the BEHAVIOUR, and the existence test holds the metric. */
async function counterOrNull(name, where = {}) {
  const m = (await register.getMetricsAsJSON()).find(x => x.name === name);
  return m ? seriesSum(m, where) : null;
}
function seriesSum(m, where) {
  return m.values
    .filter(v => /file/.test(String(v.labels.kind ?? '')))
    .filter(v => Object.entries(where).every(([k, val]) => v.labels[k] === val))
    .reduce((a, v) => a + v.value, 0);
}
const countersNow = async () => ({
  issuer: await counterOrNull('ythril_sync_tombstones_applied_total', { ground: 'issuer' }),
  upstream: await counterOrNull('ythril_sync_tombstones_applied_total', { ground: 'upstream' }),
  declined: await counterOrNull('ythril_sync_tombstones_declined_total'),
});

describe('a peer file tombstone is judged by the deletion authority (D-14 = C)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftauthority', spaces: [S], lateral: true, files: true });
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
    assert.ok(ups.filter(Boolean).length >= 2, `the derivation found ${ups.filter(Boolean).length} topologies where the peer is the upstream`);
    assert.ok(ups.filter(u => !u).length >= 5, 'too few topologies where the peer is not the upstream');
    assert.ok(SCENARIOS.length >= 12, 'the scenario table shrank');
  });

  it('the two counters exist before anything is applied', async () => {
    await counter('ythril_sync_tombstones_applied_total');
    await counter('ythril_sync_tombstones_declined_total');
  });

  for (const [doorName, d] of Object.entries(DOORS)) {
    describe(`${doorName} door: every network type, every scenario`, () => {
      for (const top of topologies()) {
        it(`${top.name}`, async () => {
          await door.reset();
          // A lateral club member carries the space too, so it is served onward in every cell and "stored" means "applied".
          door.configure({ ...top.set, lateral: true });
          const upstream = peerIsUpstream();
          for (const s of SCENARIOS) await seedFile(s.id, s.author === 'ME' ? ME : s.author, s.stamp);
          // The absent-target control: a tombstone for a file this instance does not hold.
          const page = [...SCENARIOS.map((s, i) => tombFor(s.id, s.issuer, 10 + i)), tombFor('never-held', PEER, 50)];
          const before = await countersNow();
          const answer = await d.deliver(page);
          const after = await countersNow();

          const wrong = [];
          let nDeclined = 0, nIssuer = 0, nUpstream = 0;
          for (const s of SCENARIOS) {
            const want = oracle(s, upstream);
            const row = await stored('files', pathOf(s.id));
            const t = await stored('file_tombstones', `ft-${s.id}`);
            if (!want.deleted) nDeclined++; else if (want.viaUpstream) nUpstream++; else nIssuer++;
            if ((row === null) !== want.deleted) wrong.push(`${s.id} (${s.note}): the file row is ${row === null ? 'GONE' : 'STILL HERE'}, want ${want.deleted ? 'gone' : 'kept'}`);
            if (onDisk(s.id) === want.deleted) wrong.push(`${s.id}: the bytes are ${onDisk(s.id) ? 'STILL HERE' : 'GONE'}, want ${want.deleted ? 'gone' : 'kept'}`);
            if ((t !== null) !== want.deleted) {
              wrong.push(`${s.id}: the tombstone was ${t !== null ? 'stored for a deletion that was refused' : 'not stored for a deletion that was applied'}`);
            }
          }
          if ((await stored('file_tombstones', 'ft-never-held')) === null) wrong.push('never-held: a tombstone for a file not held here was not stored (the control)');
          if (doorName === 'push') {
            assert.equal(answer.code, 200, JSON.stringify(answer.body));
            if ((answer.body.declined ?? 0) !== nDeclined) {
              wrong.push(`the push answer says declined ${answer.body.declined}, want ${nDeclined}: a tombstone the receiver declined is answered as if it had landed`);
            }
          }
          const got = { issuer: after.issuer - before.issuer, upstream: after.upstream - before.upstream, declined: after.declined - before.declined };
          // The never-held control is applied-nothing on ground issuer or upstream per the module's verdict ('absent'): it is no ground
          // of either, so it is not counted in either. The scenarios decide the three numbers.
          if (before.issuer !== null && (got.issuer !== nIssuer || got.upstream !== nUpstream || got.declined !== nDeclined)) {
            wrong.push(`counters (issuer, upstream, declined) are ${[got.issuer, got.upstream, got.declined]}, want ${[nIssuer, nUpstream, nDeclined]}`);
          }
          assert.deepEqual(wrong, [], `${doorName} / ${top.name} (peer is the upstream: ${upstream})`);
        });
      }
    });
  }

  describe('the stamp is set by the door that delivered the file row, then the upstream retires it (end to end)', () => {
    const RELAYED = 'relayed-e2e.txt';
    /** Land a file row by a door, then deliver the upstream's tombstone for it by `d`; return whether the row is still here. */
    async function relayedThenDeleted(land, d) {
      await door.reset();
      await land();
      const here = await door.coll(S, 'files').findOne({ _id: RELAYED });
      assert.ok(here, 'fixture: the file row did not land');
      door.state.records = {};
      door.writeLocalFile(S, RELAYED, 'relayed bytes');
      await d.deliver([{ ...tombFor('relayed-e2e', THIRD, 60), rowSeq: here.seq }]);
      return (await door.coll(S, 'files').findOne({ _id: RELAYED })) !== null;
    }
    const meta = () => build.filemeta(S, RELAYED, 3, { author: { instanceId: THIRD, instanceLabel: THIRD } });
    const pushBy = (token) => () => door.push('/batch-upsert', { filemeta: [meta()] }, { spaceId: S, token });
    const pulledFromPeer = async () => { door.state.records[S] = { filemeta: [meta()] }; await door.sync(); };

    for (const [doorName, d] of Object.entries(DOORS)) {
      it(`${doorName}: what the UPSTREAM pushed is deleted by the upstream's tombstone`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(peerToken(PEER)), d), false,
          'a file row the upstream pushed (a third author\'s) survived the upstream\'s own tombstone — the deletion was declined');
      });
      it(`${doorName}: what the UPSTREAM served to this instance's pull is deleted by the upstream's tombstone`, async () => {
        assert.equal(await relayedThenDeleted(pulledFromPeer, d), false, 'a pulled file row survived the upstream\'s tombstone');
      });
      it(`${doorName}: what an ADMIN pushed survives it`, async () => {
        assert.equal(await relayedThenDeleted(pushBy(ADMIN_TOKEN), d), true, 'an admin-pushed file row was deleted by the upstream');
      });
    }
  });
});
