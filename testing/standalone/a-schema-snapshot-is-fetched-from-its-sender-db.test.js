/**
 * A record that arrives stamped with a schema fingerprint this server holds no snapshot of makes this server FETCH that snapshot from the member that sent it,
 * in the sync turn and never in the arrival, verified, bounded, and with every answer of the sender decided (bundle-265, Q-738; design 3.2-3.5, R4-8..R4-12).
 *
 * ## What the design asks of the receiver, case by case
 *
 * - **Owed, and when it is asked.** `writeArrivals` notes the distinct stamps of a landed page in memory; it fetches nothing and waits for nothing. The
 *   fetch is a leg of the member's turn (placed after the push leg, before the files leg), at most `SNAPSHOT_FETCHES_PER_TURN` (4) per member and space
 *   per turn; one request per fingerprint however many records carry it; never asked of a member that does not run 6.6.0 or later (unknown reads as old).
 * - **Held first.** One `find({ _id: { $in: owed } })` before any request: a fingerprint a row already holds is not asked for.
 * - **Gap scan.** The housekeeping step (`scanOwedSchemaSnapshots`, `sync/schema-snapshot-owed.ts`) owes every fingerprint a stored record carries and no
 *   row holds - what a restore, an admin push or a bounded in-memory set lost - naming the delivering peer when the row has one and "any member" when not.
 * - **Verified** (`verifySnapshot`): a text its fingerprint does not name, one that is not the canonical text, and one over 10 MiB (by `Content-Length` and by
 *   stream) are refused, nothing is stored, and the refusal is TERMINAL for that member, that version and that fingerprint: a later cycle does not ask
 *   again, a version change clears it.
 * - **Every coded answer is decided apart.** `404 unknown_fingerprint` (the member does not hold it: the next fingerprint is still asked), a `404` WITHOUT a
 *   code (the member has no such route: remembered per version, the member is not asked again), the member lost the space (`404` with the lost-space sentence, or `410 space_retired`), `409 not_shared` (terminal), `403 schema_rung`.
 * - **The transfer init.** The request is made with `transferInit(requestInit)`: the control plane's ten-second signal would win over the transfer budget
 *   and a 10 MiB snapshot from a slow peer would be aborted and retried for ever (`peer-fetch.ts` says so). A peer that answers after eleven seconds is
 *   read.
 * - **Own store trouble.** An ordinary failure of this server's own write goes through `reportSpaceFailure('Schema snapshot fetch', space, err)`; a store that
 *   is not answering (`storeIsNotAnswering`) ends the leg for the turn.
 *
 * ## How it is driven
 *
 * The real engine (`runSyncForPeer`) against `_pull-door.mjs`'s fake peer, with `_schema-snapshot-peer.mjs`'s proxy in front of it answering the snapshot
 * route as each case scripts it (unscripted, the proxy forwards to the fake peer, which 404s WITHOUT a code). The member is a pub/sub upstream running a
 * version each case chooses: the "remembered per version" outcomes are process memory, so every case runs the member at a version of its own and
 * a fingerprint of its own.
 *
 * ## Interface fixed here (the design names it, not its shape)
 *
 * `sync/schema-snapshot-owed.ts` exports `scanOwedSchemaSnapshots()`: the housekeeping step's body over every space. The row written for a fetched snapshot is
 * `{ _id: fp, text, origin: 'fetched', from: <member instanceId>, links }`. The metric is `ythril_schema_snapshot_total{outcome}`.
 *
 * ## Seen red
 *
 * At ce37b83a nothing stamps an arrival and nothing fetches: no snapshot request reaches the peer, no row appears, no outcome is counted, and
 * `sync/schema-snapshot-owed.js` does not exist.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-schema-snapshot-is-fetched-from-its-sender-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { holdDocumentLock, setWriteBoundForTest, withValidator } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import {
  openSnapshotPeer, snapshotOf, snapshotNamed, snapshotRow, snapshotsOf, stampedFact, linksOf, sha256, snapshotCount, TEN_MIB,
} from './_schema-snapshot-peer.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'snapfetch';

let door, peer, owed;
let versionN = 0;
let seq = 0;
let served = [];

const rows = () => snapshotsOf(door.mongo, S);
const heldRow = (fp) => rows().findOne({ _id: fp });
const ok = (snap, links) => ({ status: 200, body: { fp: snap.fp, text: snap.text, links: links ?? linksOf(snap.fp) } });
/** A fact stamped with `fp`, added to what the fake peer serves from now on. */
const arrives = (fp, id = `f-${fp.slice(0, 10)}-${++seq}`) => { served.push(stampedFact(build, S, id, ++seq, fp)); door.state.records = { [S]: { facts: [...served] } }; return id; };
const sync = () => door.sync();
const scan = async () => {
  assert.ok(!owed.__missing, `server/dist/sync/schema-snapshot-owed.js does not load (${owed.__missing?.code ?? owed.__missing})`);
  assert.equal(typeof owed.scanOwedSchemaSnapshots, 'function', 'sync/schema-snapshot-owed.js exports no scanOwedSchemaSnapshots (the housekeeping step)');
  await owed.scanOwedSchemaSnapshots();
};
/** Bump the member's reported version: what clears a "remembered for this version" outcome. */
const upgrade = () => door.configure({ memberExtra: { version: `6.7.${++versionN}` } });
const askedFor = () => peer.requests.map(r => r.fp);

describe('a record stamped with a snapshot this server lacks fetches it from the member that sent it', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'snapfetch', spaces: [S], type: 'pubsub', direction: 'pull', files: true });
    peer = await openSnapshotPeer(door);
    owed = await import('../../server/dist/sync/schema-snapshot-owed.js').catch(err => ({ __missing: err }));
  });
  after(async () => { await peer?.close(); await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    peer.reset();
    await rows().deleteMany({});
    served = [];
    door.configure({ memberExtra: { version: `6.6.${++versionN}` } });
  });

  describe('the fetch', () => {
    it('fetches the snapshot in the turn that pulled the record - after the page and the record landed, before the files leg - and keeps it as fetched, from the member', async () => {
      const snap = await snapshotNamed('first');
      const links = linksOf(snap.fp, [{ networkId: door.NET, fp: 'a'.repeat(64) }], []);
      const id = arrives(snap.fp);
      const before = await snapshotCount('fetched');
      let storedWhenAsked;
      peer.snapshot = async () => {
        // The arrival is a write that must not wait for a peer: when the request reaches the peer, the record is already stored.
        storedWhenAsked = !!(await door.coll(S, 'facts').findOne({ _id: id }));
        return ok(snap, links);
      };
      await sync();
      assert.deepEqual(askedFor(), [snap.fp]);
      assert.equal(storedWhenAsked, true, 'the snapshot was asked for before the record that owes it was stored: the fetch ran inside the arrival');
      assert.deepEqual({ spaceId: peer.requests[0].spaceId, networkId: peer.requests[0].networkId }, { spaceId: door.remoteOf(S), networkId: door.NET });
      const order = peer.log.map(r => r.path);
      const [page, ask, files] = [order.indexOf('/api/sync/facts'), order.indexOf('/api/sync/schema-snapshot'), order.indexOf('/api/sync/manifest')];
      assert.ok(page >= 0 && page < ask, `the snapshot was asked for before the records page (${order.join(' ')})`);
      assert.ok(files < 0 || ask < files, `the snapshot was asked for after the files leg began (${order.join(' ')})`);
      const row = await heldRow(snap.fp);
      assert.ok(row, 'no snapshot row was stored');
      assert.equal(row.text, snap.text);
      assert.equal(sha256(row.text), row._id);
      assert.equal(row.origin, 'fetched');
      assert.equal(row.from, PEER);
      assert.deepEqual(row.links, links);
      assert.equal(await snapshotCount('fetched') - before, 1);
    });

    it('asks once for a fingerprint however many records carry it, and not again in the next turn once it is held', async () => {
      const snap = await snapshotNamed('once');
      peer.snapshot = () => ok(snap);
      arrives(snap.fp); arrives(snap.fp); arrives(snap.fp);
      await sync();
      assert.deepEqual(askedFor(), [snap.fp]);
      arrives(snap.fp);
      await sync();
      assert.deepEqual(askedFor(), [snap.fp], 'a fingerprint already held was asked for again');
    });

    it('two turns that want one fingerprint ask for it once: a turn that chose it in its batch skips it when another turn asked for it, or kept it, meanwhile', async () => {
      // Seen red at c244852b: the batch was the only check, so the first turn asked for `b` again after the second turn had kept it ([a, b, b]).
      const fetch = await import('../../server/dist/sync/schema-snapshot-fetch.js');
      const [a, b] = await Promise.all([snapshotNamed('twoa'), snapshotNamed('twob')]);
      let release;
      const held = new Promise(r => { release = r; });
      let firstAsked;
      const asked = new Promise(r => { firstAsked = r; });
      peer.snapshot = async ({ fp }) => {
        if (fp === a.fp) { firstAsked(); await held; return ok(a); }
        return ok(b);
      };
      arrives(a.fp); arrives(b.fp);
      const first = sync();
      await asked;
      // The second turn, of the same member and space, while the first awaits `a`: it chooses `b` (a is in flight) and keeps it.
      await fetch.fetchOwedSchemaSnapshots({
        member: door.member(), spaceId: S, remoteSpaceId: door.remoteOf(S), networkId: door.NET, requestInit: () => ({}),
        turn: { signal: new AbortController().signal, mayContinue: () => true, refusedBy() {} },
      });
      assert.ok(await heldRow(b.fp), 'the second turn did not keep b');
      release();
      await first;
      assert.deepEqual(askedFor(), [a.fp, b.fp], 'a fingerprint another turn asked for or kept meanwhile was asked for again');
    });

    it('asks for nothing it holds: a row already there (written by something this process does not know of) is found by the held check, not overwritten', async () => {
      const snap = await snapshotNamed('held');
      await rows().insertOne(snapshotRow({ fp: snap.fp, text: snap.text, origin: 'own', links: linksOf(snap.fp) }));
      peer.snapshot = () => ok(snap);
      arrives(snap.fp);
      await sync();
      assert.deepEqual(askedFor(), [], 'a snapshot this server holds was requested');
      assert.equal((await heldRow(snap.fp)).origin, 'own');
    });

    it('asks for at most four fingerprints per member and space in one turn, and the rest in the next', async () => {
      const snaps = await Promise.all(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(snapshotNamed));
      const byFp = new Map(snaps.map(s => [s.fp, s]));
      peer.snapshot = ({ fp }) => ok(byFp.get(fp));
      for (const s of snaps) arrives(s.fp);
      await sync();
      assert.equal(peer.requests.length, 4, `${peer.requests.length} snapshots were asked for in one turn`);
      assert.equal(await rows().countDocuments({}), 4);
      await sync();
      assert.deepEqual([...askedFor()].sort(), snaps.map(s => s.fp).sort(), 'the six fingerprints were not each asked for exactly once over two turns');
      assert.equal(await rows().countDocuments({}), 6);
    });

    it('reads a snapshot the peer is slow to answer: the request carries the transfer budget, not the control plane\'s ten-second signal', { timeout: 90_000 }, async () => {
      const snap = await snapshotNamed('slow');
      peer.snapshot = () => ({ ...ok(snap), delayMs: 11_500 });
      arrives(snap.fp);
      await sync();
      assert.ok(await heldRow(snap.fp), 'a snapshot answered after eleven seconds was not kept: the control-plane signal aborted the transfer');
    });
  });

  describe('a member below the snapshot floor is never asked', () => {
    it('a member below SCHEMA_SNAPSHOT_SINCE and a member of unknown version are not asked; the records they sent still land', async () => {
      const snap = await snapshotNamed('old');
      peer.snapshot = () => ok(snap);
      door.configure({ memberExtra: { version: '6.5.4' } });
      const id1 = arrives(snap.fp);
      await sync();
      door.configure({ memberExtra: { version: undefined } });
      const id2 = arrives(snap.fp);
      await sync();
      assert.deepEqual(askedFor(), [], 'a member below the snapshot floor was asked for a snapshot');
      assert.ok(await door.coll(S, 'facts').findOne({ _id: id1 }) && await door.coll(S, 'facts').findOne({ _id: id2 }), 'the records of the old member did not land');
    });
  });

  describe('the gap scan owes what stored records carry and no row holds', () => {
    it('a stored record that carries a fingerprint nobody delivered this process (a restore) is asked for from a member that shares the space, in the next turn', async () => {
      const snap = await snapshotNamed('restored');
      peer.snapshot = () => ok(snap);
      await door.coll(S, 'facts').insertOne(stampedFact(build, S, 'restored-1', 1, snap.fp));
      await sync();
      assert.deepEqual(askedFor(), [], 'nothing owes the fingerprint before the scan has run: the fetch is for what arrivals and the scan name');
      await scan();
      await sync();
      assert.deepEqual(askedFor(), [snap.fp]);
      assert.ok(await heldRow(snap.fp));
    });

    it('finds a fingerprint in each record family, and names the peer that delivered the record', async () => {
      const [a, b] = await Promise.all([snapshotNamed('scan-fact'), snapshotNamed('scan-entity')]);
      const byFp = new Map([a, b].map(s => [s.fp, s]));
      peer.snapshot = ({ fp }) => ok(byFp.get(fp));
      await door.coll(S, 'facts').insertOne({ ...stampedFact(build, S, 'scan-f', 1, a.fp), deliveredBy: PEER });
      await door.coll(S, 'entities').insertOne({ ...build.entity(S, 'scan-e', 2, { schemaFingerprint: b.fp }), deliveredBy: PEER });
      await scan();
      await sync();
      assert.deepEqual([...askedFor()].sort(), [a.fp, b.fp].sort());
    });

    it('owes nothing for a fingerprint a row holds', async () => {
      const snap = await snapshotNamed('scan-held');
      await rows().insertOne(snapshotRow({ fp: snap.fp, text: snap.text, origin: 'own', links: linksOf(snap.fp) }));
      peer.snapshot = () => ok(snap);
      await door.coll(S, 'facts').insertOne(stampedFact(build, S, 'scan-h', 1, snap.fp));
      await scan();
      await sync();
      assert.deepEqual(askedFor(), []);
    });
  });

  describe('a fetched text is verified, and a refusal is terminal for that member, version and fingerprint', () => {
    const refusals = [
      ['a text its fingerprint does not name', 'refused_hash', async () => { const a = await snapshotNamed('mine'); const b = await snapshotNamed('theirs'); return { fp: a.fp, body: { fp: a.fp, text: b.text, links: linksOf(a.fp) } }; }],
      ['the right content pretty-printed (not the canonical text), named by its own hash', 'refused_shape', async () => {
        const a = await snapshotNamed('pretty'); const text = JSON.stringify(JSON.parse(a.text), null, 2); const fp = sha256(text);
        return { fp, body: { fp, text, links: linksOf(fp) } };
      }],
      ['a canonical text with a key a snapshot does not have', 'refused_shape', async () => {
        const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
        const a = await snapshotNamed('extra'); const text = canonicalJson({ ...JSON.parse(a.text), injected: true }); const fp = sha256(text);
        return { fp, body: { fp, text, links: linksOf(fp) } };
      }],
      ['a text over 10 MiB, announced by its Content-Length', 'over_cap', async () => {
        const text = 'x'.repeat(TEN_MIB + 1); const fp = sha256(text);
        return { fp, body: { fp, text, links: linksOf(fp) } };
      }],
      ['a text over 10 MiB, streamed with no Content-Length', 'over_cap', async () => {
        const text = 'y'.repeat(TEN_MIB + 1); const fp = sha256(text);
        return { fp, body: { fp, text, links: linksOf(fp) }, chunked: true };
      }],
    ];
    for (const [what, outcome, make] of refusals) {
      it(`refuses ${what}: nothing is stored, ${outcome} is counted, a later cycle does not ask again, and a new version of the member does`, { timeout: 60_000 }, async () => {
        const { fp, body, chunked } = await make();
        peer.snapshot = () => ({ status: 200, body, chunked });
        arrives(fp);
        const before = await snapshotCount(outcome);
        await sync();
        assert.deepEqual(askedFor(), [fp]);
        assert.equal(await heldRow(fp), null, 'a refused snapshot was stored');
        assert.equal(await snapshotCount(outcome) - before, 1);
        await scan(); await sync();
        assert.deepEqual(askedFor(), [fp], 'a terminal refusal was asked for again by the same member at the same version');
        upgrade();
        await scan(); await sync();
        assert.deepEqual(askedFor(), [fp, fp], 'the refusal outlived the member\'s version change');
      });
    }
  });

  describe('every answer of the sender is decided on its own', () => {
    it('404 unknown_fingerprint: the member does not hold that one, and the next fingerprint is still asked of it (it is not a missing route)', async () => {
      const [x, y] = await Promise.all([snapshotNamed('nx'), snapshotNamed('ny')]);
      peer.snapshot = ({ fp }) => (fp === x.fp ? { status: 404, body: { code: 'unknown_fingerprint' } } : ok(y));
      arrives(x.fp); arrives(y.fp);
      const before = await snapshotCount('not_held');
      await sync();
      assert.deepEqual([...askedFor()].sort(), [x.fp, y.fp].sort());
      assert.ok(await heldRow(y.fp), 'a coded 404 stopped the member from being asked the next fingerprint');
      assert.equal(await heldRow(x.fp), null);
      assert.equal(await snapshotCount('not_held') - before, 1);
    });

    it('404 without a code: the member has no such route, so it is remembered for its version and not asked again - until it reports another', async () => {
      const [x, y] = await Promise.all([snapshotNamed('rx'), snapshotNamed('ry')]);
      peer.snapshot = ({ fp }) => (fp === x.fp ? { status: 404, body: { error: 'not found' } } : ok(y));
      arrives(x.fp);
      const before = await snapshotCount('route_missing');
      await sync();
      arrives(y.fp);
      await sync();
      assert.deepEqual(askedFor(), [x.fp], 'a member that answered a route-less 404 was asked again at the same version');
      assert.equal(await snapshotCount('route_missing') - before, 1);
      upgrade();
      await scan(); await sync();
      assert.ok(askedFor().length > 1, 'the member was not asked again after its version changed');
    });

    // What the member's one existence rule answers for a space it does not have (`sendLostSpace`, as GET /meta answers it): 404 with the sentence and no
    // code, or 410 `space_retired` for a retired id. The first is told from a missing route by its words.
    const lostSpaceAnswers = {
      '404 with the sentence unknownSpaceSentence spells and no code': ({ spaceId }) => ({ status: 404, body: { error: `Space '${spaceId}' not found` } }),
      '410 space_retired': ({ spaceId }) => ({ status: 410, body: { error: `Space '${spaceId}' is retired`, code: 'space_retired' } }),
    };
    for (const [name, lost] of Object.entries(lostSpaceAnswers)) it(`${name}: the member no longer has the space, so it is not asked for this space again until its version changes`, async () => {
      const [x, y] = await Promise.all([snapshotNamed(`lx${name.length}`), snapshotNamed(`ly${name.length}`)]);
      peer.snapshot = (ask) => (ask.fp === x.fp ? lost(ask) : ok(y));
      arrives(x.fp);
      const before = await snapshotCount('lost_space');
      await sync();
      arrives(y.fp);
      await sync();
      assert.deepEqual(askedFor(), [x.fp], 'a member that said the space is gone was asked about it again');
      assert.equal(await snapshotCount('lost_space') - before, 1);
      upgrade();
      await scan(); await sync();
      assert.ok(await heldRow(y.fp), 'the member was not asked again after its version changed');
    });

    it('a member that fails every ask is said once per window for the space, not once per failed fingerprint; each failure is still counted', async () => {
      // Seen red at c244852b: one warn line per failed ask (two here, and one per space per minute for as long as the member fails).
      const [x, y] = await Promise.all([snapshotNamed('fail1'), snapshotNamed('fail2')]);
      peer.snapshot = () => ({ status: 500, body: { error: 'scripted failure' } });
      // The window starts here: an earlier case's failure of this member and space would otherwise have said it already.
      (await import('../../server/dist/sync/schema-snapshot-fetch.js')).forgetSchemaSnapshotOutcomes();
      arrives(x.fp); arrives(y.fp);
      const before = await snapshotCount('failed');
      const { lines } = await logLinesDuring(() => sync());
      assert.equal(await snapshotCount('failed') - before, 2, 'each failed ask is counted');
      const said = lines.filter(l => l.includes('Schema snapshot') && l.includes('HTTP 500'));
      assert.equal(said.length, 1, `the member's failure was said ${said.length} times in one window: ${JSON.stringify(said)}`);
    });

    it('409 not_shared: terminal for that member, version and fingerprint (the records keep their stamp; the snapshot is unavailable there)', async () => {
      const x = await snapshotNamed('sx');
      peer.snapshot = () => ({ status: 409, body: { code: 'not_shared' } });
      arrives(x.fp);
      await sync();
      assert.equal(await heldRow(x.fp), null);
      await scan(); await sync();
      assert.deepEqual(askedFor(), [x.fp], 'a refusal that is final was asked for again');
      upgrade();
      await scan(); await sync();
      assert.deepEqual(askedFor(), [x.fp, x.fp]);
    });

    it('403 schema_rung: counted refused_rung, nothing stored, and the turn goes on', async () => {
      const x = await snapshotNamed('wx');
      peer.snapshot = () => ({ status: 403, body: { code: 'schema_rung' } });
      const id = arrives(x.fp);
      const before = await snapshotCount('refused_rung');
      await sync();
      assert.equal(await snapshotCount('refused_rung') - before, 1);
      assert.equal(await heldRow(x.fp), null);
      assert.ok(await door.coll(S, 'facts').findOne({ _id: id }));
    });
  });

  describe('this server\'s own store', () => {
    it('an ordinary failure of the write is reported through the shared reporter, under the fetch\'s own step and the space, and the next fingerprint is still taken', async () => {
      const [bad, good] = await Promise.all([snapshotNamed('badwrite'), snapshotNamed('goodwrite')]);
      peer.snapshot = ({ fp }) => ok(fp === bad.fp ? bad : good);
      await door.mongo.getDb().createCollection(`${S}_schema_snapshots`).catch(() => {});
      arrives(bad.fp); arrives(good.fp);
      const { lines } = await logLinesDuring(() => withValidator(door.mongo.getDb(), `${S}_schema_snapshots`, { _id: { $ne: bad.fp } }, () => sync()));
      assert.ok(lines.some(l => l.includes('Schema snapshot fetch') && l.includes(S)), `no line names the step and the space: ${JSON.stringify(lines.slice(-6))}`);
      assert.equal(await heldRow(bad.fp), null);
      assert.ok(await heldRow(good.fp), 'one refused write stopped the fingerprints behind it');
    });

    it('a store that is not answering ends the leg for the turn: the next fingerprint is not asked', { timeout: 60_000 }, async () => {
      const [x, y] = await Promise.all([snapshotNamed('lockx'), snapshotNamed('locky')]);
      const byFp = new Map([x, y].map(s => [s.fp, s]));
      peer.snapshot = ({ fp }) => ok(byFp.get(fp));
      await door.mongo.getDb().createCollection(`${S}_schema_snapshots`).catch(() => {});
      const restore = await setWriteBoundForTest({ writeTimeoutMs: 1500, holdDeadlineMs: 1500 });
      const lockX = await holdDocumentLock(door.mongo, `${S}_schema_snapshots`, { insert: { _id: x.fp } });
      const lockY = await holdDocumentLock(door.mongo, `${S}_schema_snapshots`, { insert: { _id: y.fp } });
      try {
        arrives(x.fp); arrives(y.fp);
        await sync().catch(() => { /* the leg's own fault is rethrown to the turn */ });
        assert.equal(peer.requests.length, 1, `${peer.requests.length} fingerprints were asked for: a store that did not answer did not end the leg`);
      } finally {
        await lockX.release(); await lockY.release(); restore();
      }
    });
  });
});
