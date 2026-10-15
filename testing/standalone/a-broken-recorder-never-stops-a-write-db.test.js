/**
 * A recorder that BREAKS never stops the write it was recording, and says so once (Q-93, plan R6-9: "a recorder failure warns
 * once and is counted, and a test breaks it and sees the write land").
 *
 * ## Why the rule exists
 *
 * Sync and import never refuse for a schema: a peer validated the record against ITS schema, and a refusal would discard data
 * the sender believes it delivered (`violationsAgainstLocalSchema`). The recording of what was wrong is a side effect of an
 * arrival that has already landed, so a fault in it (a log sink that throws, a counter that cannot move) must not turn a
 * stored record into a failed push, a held pull watermark or a refused page: the sender would re-offer a record that is
 * already here for ever, and nobody could say why. And a recorder that fails SILENTLY is the other way to lose the data: the
 * operator would read "nothing wrong" where there is something wrong and no recorder to say it.
 *
 * ## The seam, and why it is the sink
 *
 * No export of `server/dist` can be replaced (ES module namespaces are read-only) and `server/src` is not touched by a test, so
 * the recording STEP is broken where it ends: at the line it writes. R6-9 says the recorder says what it found in one
 * `warnOnce` log line per (space, peer) per window, so a log function that throws for a line naming the arriving key is a
 * recorder whose last step fails, exactly as a full disk or a closed sink fails it. Everything else the arrival does is the
 * real code. Nothing here names the recorder's module, its function or its wording: a line names the key, or it does not.
 * The failure line the recorder then writes names no key, and is what the "once" cases count.
 *
 * ## What each case holds
 *
 *  - the write LANDS and the arrival is answered as a clean one is (the push door 200 `ok`, the batch 200 with every document
 *    counted upserted, the pull cycle with no error): green on the unchanged base, which has no recorder to break.
 *  - the recorder WAS reached (the sink was asked to say the key): red on the base, which records nothing.
 *  - the failure is said ONCE over repeated arrivals (three pushes from three peers, so the recorder's own report is not
 *    suppressed three times over; three pulled pages), as one line that is neither noise the cycle writes anyway nor the key.
 *  - a space that records nothing (off) has no recording to fail: no failure line.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-broken-recorder-never-stops-a-write-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { undeclaredKeySpaces, spaceOf } from './_undeclared-key-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SECRET = 'SECRET-VALUE-9f3a';
/** Every key this file adds starts with this: the sink fails for a line that names one, and for no other. */
const MARK = 'zzBrk';

const SPACES = Object.freeze({ push: 'ukbrkpush', off: 'ukbrkoff', pullRepeat: 'ukbrkpullrepeat', pullLand: 'ukbrkpullland' });
const metaOf = (mode) => structuredClone(undeclaredKeySpaces().find(s => s.id === spaceOf(mode)).meta);
const META = {
  [SPACES.push]: metaOf('warn'), [SPACES.off]: metaOf('off'),
  [SPACES.pullRepeat]: metaOf('warn'), [SPACES.pullLand]: metaOf('warn'),
};

let door, engine, log, pusher = 0;

const entity = (space, id, seq, ...keys) => build.entity(space, id, seq,
  { type: 'service', properties: { status: 'up', ...Object.fromEntries(keys.map(k => [k, SECRET])) } });
const nextPeer = () => peerToken(`ukbrk-peer-${++pusher}`);
const storedIds = async (space) => (await door.coll(space, 'entities').find({}).toArray()).map(d => d._id).sort();

/**
 * Run `fn` with the log's sink broken for any line that names a MARK key. `lines` are the lines that were written, `attempts`
 * the ones the sink was asked for and refused (what the recorder tried to say).
 */
async function withBrokenSink(fn) {
  const lines = []; const attempts = [];
  const orig = { warn: log.warn, error: log.error, info: log.info };
  for (const k of Object.keys(orig)) {
    log[k] = (...a) => {
      const line = a.join(' ');
      if (line.includes(MARK)) { attempts.push(line); throw new Error('injected sink failure'); }
      lines.push(line);
    };
  }
  try { return { result: await fn(), lines, attempts }; } finally { Object.assign(log, orig); }
}

async function cycle() {
  const out = await engine.runSyncForNetwork(door.NET);
  await door.settled();
  return out;
}

/** The lines a clean arrival through this door writes anyway (a cycle logs each 404 of a fake peer), so a case counts only what is new. */
async function noiseOf(arrive) {
  const { lines } = await withBrokenSink(arrive);
  return new Set(lines);
}

describe('a broken recorder never stops a write and says so once', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'undeclkeysrecordb', spaces: Object.values(SPACES), meta: META });
    engine = await import('../../server/dist/sync/engine.js');
    ({ log } = await import('../../server/dist/util/log.js'));
  });
  after(async () => { await door?.close(); });

  describe('push (single)', () => {
    it('the write lands and the push is answered as a clean one is, although the recorder\'s sink throws', async () => {
      await door.wipe(SPACES.push);
      const { result } = await withBrokenSink(() => door.push('/entities', entity(SPACES.push, 'e1', 5, `${MARK}One`), { spaceId: SPACES.push, token: nextPeer() }));
      assert.equal(result.code, 200, `the push was refused for a fault in the recording: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.status, 'ok', JSON.stringify(result.body));
      assert.deepEqual(await storedIds(SPACES.push), ['e1'], 'the write did not land');
      assert.equal((await door.coll(SPACES.push, 'entities').findOne({ _id: 'e1' })).properties[`${MARK}One`], SECRET, 'the stored copy lost its key');
    });

    it('the recorder was reached: it asked its sink to say the undeclared key', async () => {
      await door.wipe(SPACES.push);
      const { attempts } = await withBrokenSink(() => door.push('/entities', entity(SPACES.push, 'e1', 5, `${MARK}Reached`), { spaceId: SPACES.push, token: nextPeer() }));
      assert.ok(attempts.length >= 1, 'nothing asked the log to say the stored document\'s undeclared key: the arrival was not recorded, so no recorder was broken');
    });

    it('the failure of the recording is said ONCE over repeated pushes, as a line that does not name the key', async () => {
      await door.wipe(SPACES.push);
      const noise = await noiseOf(() => door.push('/entities', entity(SPACES.push, 'clean', 4), { spaceId: SPACES.push, token: nextPeer() }));
      const { result, lines, attempts } = await withBrokenSink(async () => {
        const answers = [];
        for (const id of ['r1', 'r2', 'r3']) answers.push(await door.push('/entities', entity(SPACES.push, id, 5, `${MARK}${id}`), { spaceId: SPACES.push, token: nextPeer() }));
        return answers;
      });
      assert.deepEqual(result.map(r => r.code), [200, 200, 200], 'a push was refused for a fault in the recording');
      assert.deepEqual((await storedIds(SPACES.push)).filter(id => id.startsWith('r')), ['r1', 'r2', 'r3'], 'a write did not land');
      assert.ok(attempts.length >= 1, 'the recorder never reached its sink, so there was no failure to say');
      const said = lines.filter(l => !noise.has(l));
      assert.equal(said.length, 1, `expected the recorder's failure said exactly once over three pushes, got ${said.length}: ${JSON.stringify(said)}`);
      assert.ok(!said[0].includes(SECRET), 'the failure line carries the key\'s value');
    });
  });

  describe('push (batch)', () => {
    it('every document of the page lands and the page is answered as a clean one is, although the recorder\'s sink throws', async () => {
      await door.wipe(SPACES.push);
      const docs = ['b1', 'b2', 'b3'].map(id => entity(SPACES.push, id, 5, `${MARK}${id}`));
      const { result, attempts } = await withBrokenSink(() => door.push('/batch-upsert', { entities: docs }, { spaceId: SPACES.push, token: nextPeer() }));
      assert.equal(result.code, 200, `the page was refused for a fault in the recording: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.entities.upserted, 3, `the page was not answered as three upserts: ${JSON.stringify(result.body.entities)}`);
      assert.deepEqual(await storedIds(SPACES.push), ['b1', 'b2', 'b3'], 'a document of the page did not land');
      assert.ok(attempts.length >= 1, 'nothing asked the log to say the page\'s undeclared keys: no recorder was broken');
    });

    it('the failure is said ONCE over repeated pages', async () => {
      await door.wipe(SPACES.push);
      const noise = await noiseOf(() => door.push('/batch-upsert', { entities: [entity(SPACES.push, 'clean', 4)] }, { spaceId: SPACES.push, token: nextPeer() }));
      const { result, lines, attempts } = await withBrokenSink(async () => {
        const answers = [];
        for (const id of ['p1', 'p2', 'p3']) answers.push(await door.push('/batch-upsert', { entities: [entity(SPACES.push, id, 5, `${MARK}${id}`)] }, { spaceId: SPACES.push, token: nextPeer() }));
        return answers;
      });
      assert.deepEqual(result.map(r => r.code), [200, 200, 200]);
      assert.ok(attempts.length >= 1, 'the recorder never reached its sink, so there was no failure to say');
      const said = lines.filter(l => !noise.has(l));
      assert.equal(said.length, 1, `expected the recorder's failure said exactly once over three pages, got ${said.length}: ${JSON.stringify(said)}`);
    });
  });

  describe('pull', () => {
    it('the pulled document lands and the cycle ends without an error, although the recorder\'s sink throws', async () => {
      door.state.records = { [SPACES.pullLand]: { entities: [entity(SPACES.pullLand, 'e1', 5, `${MARK}Pulled`)] } };
      const { result, attempts } = await withBrokenSink(cycle);
      assert.equal(result.errors, 0, `the cycle failed for a fault in the recording: ${JSON.stringify(result)}`);
      assert.deepEqual(await storedIds(SPACES.pullLand), ['e1'], 'the pulled write did not land');
      assert.ok(attempts.length >= 1, 'nothing asked the log to say the pulled document\'s undeclared key: the pull records nothing, so no recorder was broken');
    });

    it('the failure is said ONCE over repeated cycles, and the pulled watermark does not wait for it', async () => {
      door.state.records = { [SPACES.pullRepeat]: { entities: [entity(SPACES.pullRepeat, 'clean', 4)] } };
      const noise = await noiseOf(cycle);
      const { result, lines, attempts } = await withBrokenSink(async () => {
        const outs = [];
        for (const id of ['c1', 'c2', 'c3']) {
          door.state.records = { [SPACES.pullRepeat]: { entities: [entity(SPACES.pullRepeat, id, 5 + outs.length, `${MARK}${id}`)] } };
          outs.push(await cycle());
        }
        return outs;
      });
      assert.deepEqual(result.map(o => o.errors), [0, 0, 0], 'a cycle failed for a fault in the recording');
      assert.deepEqual((await storedIds(SPACES.pullRepeat)).filter(id => /^c\d$/.test(id)), ['c1', 'c2', 'c3'], 'a pulled write did not land');
      assert.ok(attempts.length >= 1, 'the recorder never reached its sink, so there was no failure to say');
      const said = lines.filter(l => !noise.has(l));
      assert.equal(said.length, 1, `expected the recorder's failure said exactly once over three cycles, got ${said.length}: ${JSON.stringify(said)}`);
    });
  });

  describe('a space that records nothing', () => {
    it('(control) an off space has no recording to fail: the write lands and no line is said', async () => {
      await door.wipe(SPACES.off);
      const noise = await noiseOf(() => door.push('/entities', entity(SPACES.off, 'clean', 4), { spaceId: SPACES.off, token: nextPeer() }));
      const { result, lines, attempts } = await withBrokenSink(() => door.push('/entities', entity(SPACES.off, 'e1', 5, `${MARK}Off`), { spaceId: SPACES.off, token: nextPeer() }));
      assert.equal(result.code, 200, JSON.stringify(result.body));
      assert.deepEqual(await storedIds(SPACES.off), ['clean', 'e1']);
      assert.deepEqual(attempts, [], 'the off space asked the log to say an undeclared key');
      assert.deepEqual(lines.filter(l => !noise.has(l)), [], 'the off space said something for a recording it does not make');
    });
  });
});
