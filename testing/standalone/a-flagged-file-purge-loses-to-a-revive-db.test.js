/**
 * The purge of a flagged file row loses to a revive, is not reported as damage when it does, says its own failures under its own
 * steps — and the file tombstone, not the row, is what stops a stale peer copy once the row is gone (bundle-89, E2, Q-418;
 * plan items 11 and 14).
 *
 * ## What each case holds
 *
 *  1. **A revive between the purge's read and its delete wins.** The row a person re-uploaded (`$unset deletedAt`) is a live file
 *     again; a purge whose delete does not require the flag would destroy it. The revive is made to happen at exactly that moment:
 *     the first delete the sweep issues on the space's `files` collection is preceded by the revive, whatever shape the purge's
 *     read took. The seam is a wrap of the Mongo `Collection` prototype's delete methods (the way `_push-door.mjs` wraps
 *     `updateOne` for its counter probe). `record-write-observer.ts` reports a write only after it completed, and
 *     `_write-faults.mjs` can park a write behind a gate but needs the purge's write shape known up front; the wrap needs
 *     neither, so it is the least invasive seam that exists.
 *  2. **That legitimate loss is not damage.** `sweepCollection`'s default `isStored` check reads "the deleter matched nothing and
 *     the row is still stored" as a failure, which for a revive that won is false: no failure line through the shared reporter,
 *     no `space-failure` and no `records-failed` signal. The unit needs its own "still flagged" predicate.
 *  3. **The flagged-purge unit declares its own steps.** `sweepCollection` derives its read and delete steps from the collection
 *     name and ends a clean run with `recovered(step, space)`. A second `files` unit sharing those steps lets the live unit's
 *     clean finish forget the flagged unit's failing line, so the line is said again every cycle. Held here as: a purge that
 *     keeps failing says ONE line across three sweeps in which the live `files` unit finished clean every time.
 *  4. **The tombstone outlives the row's reap.** After the flagged row is gone only the file tombstone stops a stale copy of the
 *     deleted file arriving by the sync door (arrivals.ts, "Except onto a row this instance FLAGGED", is what protects today
 *     while the row exists). A control that pins the invariant, on BOTH arrival doors (push, pull): it is green on the base,
 *     where the purge does not exist yet (the row is removed by hand when the sweep did not remove it, and the assertion says
 *     which), and goes red if a purge drops the tombstone or the arrival path starts to trust the absence of a row.
 *
 * Sweeps are the real `sweepExpired(now)` at a `now` the test chooses; the flagged rows are seeded with a fixed old `deletedAt`
 * and NO `_expireAt`, so only the flag's own clock can make them due, with a 30-day file window on the space.
 *
 * Run: node --test testing/standalone/a-flagged-file-purge-loses-to-a-revive-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'b89e2drevive';
/** A second space for the case about reporter lines: the process-wide reporter's memory is per (step, space), so it is clean here. */
const S2 = 'b89e2drevtwo';
const WINDOW_DAYS = 30;
const FLAGGED_AT = '2026-06-01T00:00:00.000Z';
/** Well past FLAGGED_AT + the window, and past nothing else. */
const NOW = new Date('2026-10-01T00:00:00.000Z');
const LOCAL_AUTHOR = { instanceId: 'b89e2drevive-receiver', instanceLabel: 'Receiver' };

let door, ttl, signals, loader;

const rowOf = (space, id) => door.coll(space, 'files').findOne({ _id: id });
const flaggedRow = (space, id, seq = 3, extra = {}) => build.filemeta(space, id, seq, { author: LOCAL_AUTHOR, deletedAt: FLAGGED_AT, ...extra });
const liveRow = (space, id, seq = 4) => build.filemeta(space, id, seq, { author: LOCAL_AUTHOR, sizeBytes: 3 });

/**
 * Wrap the delete methods of the Mongo collection class for ONE space's `files`: `hook(method, args)` runs (awaited) BEFORE every
 * delete the code under test issues on it. Returns what was seen and a `restore()`.
 */
function onFilesDeletes(space, hook) {
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const names = ['deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite'];
  const originals = Object.fromEntries(names.map(n => [n, proto[n]]));
  const hits = [];
  for (const n of names) {
    proto[n] = async function wrapped(...args) {
      const deleting = this.collectionName === `${space}_files`
        && (n !== 'bulkWrite' || (Array.isArray(args[0]) && args[0].some(op => op.deleteOne || op.deleteMany)));
      if (deleting) { hits.push(n); await hook(n, args); }
      return originals[n].apply(this, args);
    };
  }
  return { hits, restore() { for (const n of names) proto[n] = originals[n]; } };
}

/** Everything a sweep said about a failure: the lines an operator reads, and the counted signals. */
async function sweepAndListen(now) {
  const heard = [];
  const off = signals.onHousekeepingSignal((e) => { if ((e.type === 'space-failure' || e.type === 'records-failed') && String(e.step).startsWith('TTL sweep')) heard.push(e); });
  try {
    const { lines } = await logLinesDuring(() => ttl.sweepExpired(now));
    return { lines, heard };
  } finally { off(); }
}

describe('a flagged file row\'s purge: a revive wins, a loss is not damage, its failures are its own, the tombstone stays', { skip }, () => {
  before(async () => {
    door = await openPullDoor({
      suite: 'b89e2drevive', spaces: [S, S2], files: true,
      meta: { [S]: { suppressEmbeddings: true }, [S2]: { suppressEmbeddings: true } },
      spaceExtra: { [S]: { recordTtlDays: { file: WINDOW_DAYS } }, [S2]: { recordTtlDays: { file: WINDOW_DAYS } } },
    });
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const s of [S, S2]) loader.getConfig().spaces.find(x => x.id === s).recordTtlDays = { file: WINDOW_DAYS };
  });

  describe('a revive between the purge\'s read and its delete', () => {
    /** Two due flagged rows and a live one; A is revived just before the first delete the sweep issues. */
    async function sweepWithARevive() {
      await door.coll(S, 'files').insertMany([flaggedRow(S, 'docs/a.txt'), flaggedRow(S, 'docs/b.txt'), liveRow(S, 'docs/live.txt')]);
      let revived = false;
      const seam = onFilesDeletes(S, async () => {
        if (revived) return;
        revived = true;
        await door.coll(S, 'files').updateOne({ _id: 'docs/a.txt' }, { $unset: { deletedAt: '' } });
      });
      try {
        const out = await sweepAndListen(NOW);
        return { ...out, deletes: seam.hits };
      } finally { seam.restore(); }
    }

    it('the revived row survives, the row still flagged is reaped, and the live row is untouched', async () => {
      const out = await sweepWithARevive();
      const state = {};
      for (const id of ['docs/a.txt', 'docs/b.txt', 'docs/live.txt']) {
        const r = await rowOf(S, id);
        state[id] = r === null ? 'absent' : r.deletedAt === undefined ? 'live' : 'flagged';
      }
      assert.deepEqual(state, { 'docs/a.txt': 'live', 'docs/b.txt': 'absent', 'docs/live.txt': 'live' },
        `the purge must reap B (flagged, due) and lose to A's revive (deletes seen on files: [${out.deletes}]); `
        + 'a purge that deletes by id alone, without requiring the flag, destroys the revived file');
    });

    it('the loss is not reported: no failure line, no space-failure or records-failed signal', async () => {
      const out = await sweepWithARevive();
      assert.ok(out.deletes.length > 0, 'fixture: the sweep issued no delete on the files collection, so there was no purge to lose the race');
      const damage = out.lines.filter(l => /failed for space|records? failed|keep failing/i.test(l));
      assert.deepEqual({ lines: damage, signals: out.heard }, { lines: [], signals: [] },
        'a revive that won was reported as a failure: the unit needs its own "still flagged" exists-predicate, not the default isStored');
    });
  });

  it('a purge that keeps failing says ONE line across three sweeps, though the live files unit finishes clean in each', async () => {
    // B is the only due row, in S2. Every delete on S2's files fails; nothing live is expired, so the live files unit is clean.
    await door.coll(S2, 'files').insertOne(flaggedRow(S2, 'docs/b.txt'));
    const seam = onFilesDeletes(S2, async () => { throw new Error('injected: delete refused'); });
    let said;
    try {
      const lines = [];
      for (let i = 0; i < 3; i++) lines.push(...(await sweepAndListen(new Date(NOW.getTime() + i * 60_000))).lines);
      said = lines.filter(l => l.includes(`failed for space '${S2}'`) && l.includes('TTL sweep'));
    } finally { seam.restore(); }
    assert.ok(seam.hits.length >= 3, `fixture: the purge tried ${seam.hits.length} delete(s) over three sweeps; a failing purge is tried every cycle`);
    assert.equal(said.length, 1,
      `the failing flagged-purge unit said ${said.length} line(s) over three cycles (want exactly 1: once per window). `
      + `With steps shared with the live files unit, that unit's clean finish forgets the failing line and it is said again. Lines: ${JSON.stringify(said)}`);
  });

  describe('control: once the flagged row is gone, the file tombstone alone stops a stale peer copy', () => {
    const F = 'docs/deleted.txt';
    const G = 'docs/other.txt';
    const DOORS = {
      push: {
        async deliver(docs) {
          const a = await door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) });
          return a.body.filemeta;
        },
      },
      pull: { async deliver(docs) { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; } },
    };

    for (const [name, d] of Object.entries(DOORS)) {
      it(`${name}: a stale copy of the deleted file does not land after the flagged row was reaped; an unrelated path does (so the delivery works)`, async () => {
        // The state a peer's deletion leaves on an instance that keeps an audit record: the peer-authored row, flagged, and the
        // tombstone the peer issued (its rowSeq the row's). The issuer is the PEER on purpose: a tombstone speaks only against
        // versions its own issuer authored (`tombstoneGoverns`), so one issued HERE does not refuse a copy its author delivers.
        await door.coll(S, 'files').insertOne(flaggedRow(S, F, 3, { author: PEER_AUTHOR }));
        await door.coll(S, 'file_tombstones').insertOne({
          _id: `held-${F}`, spaceId: S, path: F, deletedAt: FLAGGED_AT, positionAt: FLAGGED_AT, rowSeq: 3, issuer: PEER,
        });
        await ttl.sweepExpired(NOW);
        const reapedBySweep = (await rowOf(S, F)) === null;
        // The purge does not exist on the base: simulate it, and say so in the failure text. Idempotent once a sweep does it.
        await door.coll(S, 'files').deleteOne({ _id: F, deletedAt: { $exists: true } });
        assert.equal(await rowOf(S, F), null, 'fixture: the flagged row is still stored');
        assert.ok(await door.coll(S, 'file_tombstones').findOne({ path: F }),
          `the purge (by ${reapedBySweep ? 'the sweep' : 'hand, the sweep did not reap'}) took the file tombstone with the row: nothing now stops a stale peer copy`);

        const answer = await d.deliver([build.filemeta(S, F, 3, { author: PEER_AUTHOR }), build.filemeta(S, G, 3, { author: PEER_AUTHOR })]);
        const landed = { [F]: (await rowOf(S, F)) !== null, [G]: (await rowOf(S, G)) !== null };
        assert.deepEqual(landed, { [F]: false, [G]: true },
          `a stale peer copy resurrected the deleted file once its flagged row was gone (row removed by ${reapedBySweep ? 'the sweep' : 'hand'}); `
          + `the tombstone is what must stop it${answer ? `; answer: ${JSON.stringify(answer)}` : ''}`);
        if (answer) assert.equal(answer.tombstoned, 1, `the batch answer does not count the shadowed copy: ${JSON.stringify(answer)}`);
      });
    }
  });
});
