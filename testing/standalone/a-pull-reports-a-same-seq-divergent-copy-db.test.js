/**
 * A pull that meets a copy at the SAME seq with DIFFERENT text keeps the local copy, says so, and goes on (Q-232,
 * the pull half; 5.6.4).
 *
 * ## The rule
 *
 * Push forks an equal-seq divergence (`two-divergent-pushes-at-one-seq-keep-both-texts-db`). A pull does not fork on
 * 5.6.x — it never has, and 5.6.4 does not change that — so the pulled copy's text is not stored anywhere. What
 * 5.6.4 changes is that this is no longer SILENT: the receiver has decided about the document (kept its own), and it
 * says which ones, once:
 *
 *  - an equal-seq pulled copy whose text differs from the stored one is COUNTED and NAMED in the pull's summary line,
 *    `kept the local copy; N document(s) arrived at the same seq with different text: <ids>`;
 *  - the same when the difference is found at the write — the writer's duplicate-key read-back finds a copy stored
 *    meanwhile at the planned seq with other text (it is `diverged`, never `landed`) — and the pulled text is not
 *    counted as stored;
 *  - the position advances past such a document, exactly as it does today (the receiver decided; refetching it every
 *    cycle would change nothing), and its id is named ONCE per window, not on every cycle that re-offers it
 *    (`warnOnce` per id);
 *  - a copy at the same seq with the SAME text is not a divergence and says nothing.
 *
 * ## What 5.6.4 deliberately does NOT do (pins, green before the fix and after it)
 *
 * The pull never forks (cut Q-204): the local text stays, no `forkOf` record appears. The watermark advances.
 *
 * Seen red on 6eb5a333 (5.6.3): no line names the document, on either path.
 *
 * Run: node --test testing/standalone/a-pull-reports-a-same-seq-divergent-copy-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'pulldiv';
let door, park;
/** A fresh id per case: the report is once per window per id, so a reused id would find its first line already spent. */
let serial = 0;
const freshId = () => `dv${++serial}x`;

/** A pulled fact as the fake peer serves it. */
const pulled = (id, seq, fact) => build.fact(S, id, seq, { fact, author: { ...PEER_AUTHOR } });
/** The lines of a sync that name `id` as a word, so a longer id sharing its prefix does not count. */
const naming = (lines, id) => lines.filter(l => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(l));
const SUMMARY = /kept the local copy; (\d+) document\(s\) arrived at the same seq with different text: /;

describe('a pull reports a same-seq divergent copy it keeps the local copy over (Q-232)', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'pulldiv', spaces: [S] }); });
  beforeEach(async () => { await door.reset(); });
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });

  it('an equal-seq pulled copy with other text is named in one summary line, with its count', async () => {
    const id = freshId();
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'mine'));
    door.state.records[S] = { facts: [pulled(id, 5, 'theirs')] };
    const { lines } = await door.logsDuring(() => door.sync());
    const mine = naming(lines, id);
    assert.equal(mine.length, 1, `the divergent document was named on ${mine.length} line(s): ${JSON.stringify(lines)}`);
    const m = SUMMARY.exec(mine[0]);
    assert.ok(m, `the line does not say what happened to it: ${mine[0]}`);
    assert.equal(m[1], '1');
  });

  it('PIN the local copy is kept and nothing is forked: the pull does not fork on 5.6.x', async () => {
    const id = freshId();
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'mine'));
    door.state.records[S] = { facts: [pulled(id, 5, 'theirs')] };
    await door.sync();
    assert.equal((await door.coll(S, 'facts').findOne({ _id: id })).fact, 'mine');
    assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: id }), 0, 'a pull stored a fork');
    assert.deepEqual((await door.coll(S, 'facts').find({}).toArray()).map(d => d._id), [id]);
  });

  it('PIN the position advances past it, as it does today', async () => {
    const id = freshId();
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'mine'));
    door.state.records[S] = { facts: [pulled(id, 5, 'theirs')] };
    await door.sync();
    assert.ok((door.member().lastSeqReceived?.[S] ?? 0) >= 5,
      `the watermark stayed at ${door.member().lastSeqReceived?.[S] ?? 0}: a document the receiver decided about holds the transfer`);
  });

  it('its id is named once per window: the cycle that offers it again says nothing more', async () => {
    const id = freshId();
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'mine'));
    door.state.records[S] = { facts: [pulled(id, 5, 'theirs')] };
    const first = await door.logsDuring(() => door.sync());
    const second = await door.logsDuring(() => door.sync());
    assert.equal(naming(first.lines, id).length, 1, `the first cycle did not name it: ${JSON.stringify(first.lines)}`);
    assert.deepEqual(naming(second.lines, id), [], 'the second cycle named the same id again');
  });

  it('PIN a copy at the same seq with the SAME text is not a divergence and is not named', async () => {
    const id = freshId();
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'same'));
    door.state.records[S] = { facts: [pulled(id, 5, 'same')] };
    const { lines } = await door.logsDuring(() => door.sync());
    assert.deepEqual(naming(lines, id), []);
    assert.deepEqual(lines.filter(l => SUMMARY.test(l)), []);
  });

  it('a copy stored meanwhile at the planned seq with other text is diverged at the write: named, not landed, never forked', async () => {
    const id = freshId();
    park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    const { reached, release } = park.arm(`${S}_facts`, { when: (method) => method === 'bulkWrite' });
    door.state.records[S] = { facts: [pulled(id, 5, 'theirs')] };
    const syncing = door.logsDuring(() => door.sync());
    await reached;
    // What a push from another peer does while the pull's write is parked: the same id lands at the same seq.
    await door.coll(S, 'facts').insertOne(pulled(id, 5, 'competitor'));
    release();
    const { lines } = await syncing;
    park.restore(); park = undefined;
    assert.equal((await door.coll(S, 'facts').findOne({ _id: id })).fact, 'competitor');
    assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: id }), 0, 'a pull stored a fork');
    const mine = naming(lines, id);
    assert.ok(mine.length >= 1 && mine.some(l => /same seq|diverge/i.test(l)),
      `the pulled text was counted as stored and said nothing: ${JSON.stringify(lines)}`);
  });
});