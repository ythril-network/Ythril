/**
 * An arriving peer file tombstone keeps a stored file only when the file is a version the tombstone did NOT erase, and that is
 * the ONE question every arrival door asks (`recreatedSince`, `files/tombstone-shadow.ts`) — bundle-71, Q-409.
 *
 * ## The defect
 *
 * `applyPeerFileTombstones` kept a stored file when `target.seq > a.rowSeq`: a seq compared ACROSS authors. Two instances' seq
 * counters are not one clock, so the answer depended on whose counter ran ahead, not on whether the erased content had come back:
 *
 *  - on the issuer ground, a row nobody authored (a legacy row) at a high seq outlived the deletion of the very file it is;
 *  - on the upstream ground, a row ANOTHER author wrote — the upstream delivered it, whoever wrote it — outlived its upstream's
 *    deletion because that author's counter was higher than the tombstone's `rowSeq`, and was then re-advertised to every peer
 *    below. Every other arrival door had already moved to "a newer version by the tombstone's ISSUER, or other bytes".
 *
 * ## The rule, per ground, written once
 *
 *   kept  =  the stored row is a live row AUTHORED BY THE TOMBSTONE'S ISSUER at a seq above the tombstone's `rowSeq`
 *   (an arriving tombstone carries no content hash, so the byte half of `recreatedSince` has nothing to compare and does not speak)
 *
 * What a table must show, on both doors, on the issuer ground and on every network topology where the delivering peer is this
 * instance's upstream (derived, with a floor): the issuer's re-creation survives with its bytes; the erased version goes; a row
 * whose seq is higher only because someone else wrote it goes. The ground a deletion stood on is read from the applied counter.
 *
 * ## Seen red
 *
 * On the base the cross-author rows survive (the seq alone kept them); the re-creation and the erased-version rows are green on
 * it and state what the new rule must still allow.
 *
 * Run: node --test testing/standalone/a-peer-file-tombstone-keeps-only-a-version-it-did-not-erase-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { topologies as allTopologies, peerIsUpstream as peerIsUpstreamOf } from './_network-topologies.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftkeep';
const THIRD = 'third-party-author';
const FOURTH = 'fourth-party-issuer';
const STRANGER_PARENT = 'some-other-parent';
const ERASED_SEQ = 5;

let door, upstreamOf, register;

const pathOf = (id) => `${id}.txt`;
const rowOf = (id) => door.coll(S, 'files').findOne({ _id: pathOf(id) });

/** One file here: bytes and a row at `seq`; `author` absent means a row nobody authored, `stamp` is who delivered it. */
async function seedFile(id, { author, stamp, seq }) {
  door.writeLocalFile(S, pathOf(id), `bytes of ${id}`);
  const row = build.filemeta(S, pathOf(id), seq, { sizeBytes: 11 });
  if (author === undefined) delete row.author; else row.author = { instanceId: author, instanceLabel: author };
  if (stamp !== undefined) row.deliveredBy = stamp;
  await door.coll(S, 'files').insertOne(row);
}

/** The wire tombstone of a scenario: the `issuer` key is left off when it is `undefined` (an older peer's tombstone). */
const tombFor = (id, issuer, n) => ({
  _id: `ft-${id}`, spaceId: S, path: pathOf(id), deletedAt: `2026-09-01T00:00:${String(n).padStart(2, '0')}.000Z`, rowSeq: ERASED_SEQ,
  ...(issuer !== undefined ? { issuer } : {}),
});

const DOORS = {
  push: { deliver: (tombstones) => door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }) },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
  },
};

/** The applied counter's value for a ground, over the file kinds. */
async function applied(ground) {
  const m = (await register.getMetricsAsJSON()).find(x => x.name === 'ythril_sync_tombstones_applied_total');
  assert.ok(m, 'ythril_sync_tombstones_applied_total is not registered');
  return m.values.filter(v => v.labels.kind === 'file' && v.labels.ground === ground).reduce((a, v) => a + v.value, 0);
}

/** Issuer ground: the peer is the deliverer AND the issuer, and the row is its own or nobody's. */
const ISSUER_GROUND = [
  { id: 'i-recreated', note: 'the issuer re-created it at a newer seq', row: { author: PEER, seq: ERASED_SEQ + 4 }, issuer: PEER, kept: true },
  { id: 'i-recreated-issuerless', note: 'the same, the tombstone naming no issuer (an older peer\'s: read as its deliverer)', row: { author: PEER, seq: ERASED_SEQ + 4 }, issuer: undefined, kept: true },
  { id: 'i-erased', note: 'the issuer\'s row at the erased version', row: { author: PEER, seq: ERASED_SEQ }, issuer: PEER, kept: false },
  { id: 'i-older', note: 'the issuer\'s row below the erased version', row: { author: PEER, seq: ERASED_SEQ - 3 }, issuer: PEER, kept: false },
  { id: 'i-nobody-high', note: 'a row nobody authored, its seq above the tombstone\'s (no author to say it was re-created)', row: { author: undefined, seq: ERASED_SEQ + 40 }, issuer: PEER, kept: false },
  { id: 'i-nobody-equal', note: 'a row nobody authored at the erased version', row: { author: undefined, seq: ERASED_SEQ }, issuer: PEER, kept: false },
  { id: 'i-empty-author-high', note: 'an empty author, a high seq', row: { author: '', seq: ERASED_SEQ + 40 }, issuer: PEER, kept: false },
];

/** Upstream ground: the peer is this instance's upstream and delivered the row, which a THIRD party wrote. */
const UPSTREAM_GROUND = [
  { id: 'u-recreated', note: 'the relayed issuer (the row\'s author) re-created it at a newer seq', row: { author: THIRD, stamp: PEER, seq: ERASED_SEQ + 4 }, issuer: THIRD, kept: true },
  { id: 'u-erased', note: 'the row\'s author\'s version, the erased one', row: { author: THIRD, stamp: PEER, seq: ERASED_SEQ }, issuer: THIRD, kept: false },
  { id: 'u-cross-author-other-issuer', note: 'a row ANOTHER author wrote, its counter above the tombstone\'s rowSeq', row: { author: THIRD, stamp: PEER, seq: ERASED_SEQ + 40 }, issuer: FOURTH, kept: false },
  { id: 'u-cross-author-peer-issuer', note: 'the same, the upstream issuing the deletion itself', row: { author: THIRD, stamp: PEER, seq: ERASED_SEQ + 40 }, issuer: PEER, kept: false },
  { id: 'u-nobody-high', note: 'a row nobody authored, delivered by the upstream, a high seq', row: { author: undefined, stamp: PEER, seq: ERASED_SEQ + 40 }, issuer: FOURTH, kept: false },
];

/** Deliver one page of a table and return the cells that came out wrong, plus how many deletions stood on each ground. */
async function runTable(d, table, groundOfDeleted) {
  for (const s of table) await seedFile(s.id, s.row);
  const before = await applied(groundOfDeleted);
  await d.deliver(table.map((s, i) => tombFor(s.id, s.issuer, 10 + i)));
  const wrong = [];
  for (const s of table) {
    const row = await rowOf(s.id);
    const bytes = door.localFileExists(S, pathOf(s.id));
    if ((row !== null) !== s.kept || bytes !== s.kept) {
      wrong.push(`${s.id} (${s.note}): row ${row === null ? 'GONE' : 'KEPT'}, bytes ${bytes ? 'KEPT' : 'GONE'}; want ${s.kept ? 'kept' : 'gone'}`);
    }
  }
  const deleted = table.filter(s => !s.kept).length;
  const got = (await applied(groundOfDeleted)) - before;
  if (got !== deleted) wrong.push(`the ${groundOfDeleted} ground counted ${got} deletions, want ${deleted}`);
  return wrong;
}

describe('a peer file tombstone keeps only a version it did not erase (Q-409)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftkeep', spaces: [S], files: true });
    ({ upstreamOf } = await import('../../server/dist/networks/network-spaces.js'));
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  /** The topologies where the delivering peer IS this instance's upstream, asked of the server's own `upstreamOf` on the live config. */
  const upstreamTopologies = () => allTopologies(PEER, STRANGER_PARENT).filter(t => {
    door.configure(t.set);
    return peerIsUpstreamOf(door, upstreamOf, PEER, S);
  });

  it('the tables are derived: topologies where the peer is the upstream, with a floor', () => {
    const ups = upstreamTopologies();
    assert.ok(ups.length >= 2, `the derivation found ${ups.length} topologies where the peer is the upstream`);
    assert.ok(ISSUER_GROUND.length >= 6 && UPSTREAM_GROUND.length >= 5, 'a scenario table shrank');
    assert.ok(ISSUER_GROUND.some(s => s.kept) && ISSUER_GROUND.some(s => !s.kept), 'the issuer table lost one of its outcomes');
    assert.ok(UPSTREAM_GROUND.some(s => s.kept) && UPSTREAM_GROUND.some(s => !s.kept), 'the upstream table lost one of its outcomes');
  });

  for (const [doorName, d] of Object.entries(DOORS)) {
    it(`${doorName} door, issuer ground: the issuer's re-creation survives, the erased version and a cross-author seq go`, async () => {
      assert.deepEqual(await runTable(d, ISSUER_GROUND, 'issuer'), []);
    });

    it(`${doorName} door, upstream ground, every topology where the peer is the upstream`, async () => {
      const wrong = [];
      for (const top of upstreamTopologies()) {
        await door.reset();
        door.configure(top.set);
        for (const w of await runTable(d, UPSTREAM_GROUND, 'upstream')) wrong.push(`${top.name}: ${w}`);
      }
      assert.deepEqual(wrong, []);
    });
  }
});
