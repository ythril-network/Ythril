/**
 * Two copies of a chrono entry at one seq whose bodies differ only by redaction are the SAME copy: no fork and no write, on every door
 * that takes an arrival (bundle-81 test 13; design rev 8 section 5, "New row in the truth table", rev 6 decision 8).
 *
 * ## Why this is a row of its own
 *
 * Redaction writes no seq (`brain/chrono-redaction.ts`): a lapsed retention window removes `description` and marks the entry
 * `contentRedacted` / `contentRedactedAt` in place, at the version it already had. So two instances holding one entry can hold it at
 * one seq, one redacted and one not, and each re-arrives at the other on every sync. Under the new stamp every landing takes a position,
 * so "skipped as an equal seq" is not only a matter of tidiness: a redacted copy that were written would take a fresh position,
 * be offered to every peer again, and the peer's copy would flip back. The rule: an equal-seq copy whose extra fields are within
 * `REDACTED_CHRONO_FIELDS`, with the redaction marks on one side only, is "same" — the stored row is left exactly as it is.
 *
 * ## What it holds, over the whole set it governs
 *
 * - Every arrival door is driven: the single POST (`/chrono`), `batch-upsert`, and the pull (the real engine against the fake peer).
 * - Both directions: a stored redacted copy meeting an arriving full copy, and a stored full copy meeting an arriving redacted one.
 * - Every field of `REDACTED_CHRONO_FIELDS` is read from the module (floor) and the arriving or stored full copy carries each that is
 *   not a vector, so a field added to the list is covered the day it is added.
 * - "No write" is the stored document, compared whole, local-only fields included: a sentinel `pos`, `posAtSeq` and `deliveredBy` are
 *   exactly as seeded; there is no fork row, no other row and no tombstone.
 * - The positive control is in the same case: a second entry arriving in the SAME delivery at a higher seq lands, and is found by id, so
 *   "nothing was written" is not the same sentence as "nothing arrived".
 *
 * Run: node --test testing/standalone/a-redacted-copy-is-the-same-copy-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'b81redact';
/** The space the fork-retention cases use: a content window of 14 days on the type the fixtures carry, so a fork from 2025 is due at once. */
const SR = 'b81redact-fork';
const POLICY = { typeSchemas: { chrono: { event: { retention: { days: 36500, contentDays: 14 } } } } };
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const REDACTED_AT = '2026-09-01T00:00:00.000Z';
const LOCAL = { pos: 424_242, posAtSeq: 5, deliveredBy: 'someone-who-delivered-it' };

describe('a redacted copy is the same copy', { skip }, () => {
  let door; let REDACTED_FIELDS;
  before(async () => {
    door = await openPullDoor({ suite: 'b81tD_redact', spaces: [S, SR], meta: { [SR]: POLICY } });
    ({ REDACTED_CHRONO_FIELDS: REDACTED_FIELDS } = await import('../../server/dist/brain/chrono-retention.js'));
    assert.ok(REDACTED_FIELDS.length >= 3, `only ${REDACTED_FIELDS.length} redacted field(s) derived`);
  });
  after(async () => { await door?.close(); });

  /** The full copy: every redacted field that travels (a vector and its model never do). */
  const fullBody = () => Object.fromEntries(REDACTED_FIELDS.filter(f => !/^embedding/.test(f)).map(f => [f, `${f} text`]));
  const entry = (id, seq, extra) => build.chrono(S, id, seq, { author: { ...PEER_AUTHOR }, ...extra });
  const redacted = (id, seq) => entry(id, seq, { contentRedacted: true, contentRedactedAt: REDACTED_AT });
  const full = (id, seq) => entry(id, seq, fullBody());

  const deliver = {
    single: async (docs) => { for (const doc of docs) await door.push('/chrono', doc, { spaceId: S, networkId: door.NET, token: TOKEN }); },
    batch: (docs) => door.push('/batch-upsert', { chrono: docs }, { spaceId: S, networkId: door.NET, token: TOKEN }),
    pull: async (docs) => { door.state.records[S] = { chrono: docs }; await door.sync(); },
  };

  for (const via of Object.keys(deliver)) {
    for (const [what, stored, arriving] of [
      ['a stored redacted copy meets an arriving full copy', redacted, full],
      ['a stored full copy meets an arriving redacted copy', full, redacted],
    ]) {
      it(`${via}: ${what} at one seq — the stored row is untouched, nothing forks, and a higher seq beside it lands`, async () => {
        await door.reset();
        const held = { ...stored('c', 5), ...LOCAL };
        await door.coll(S, 'chrono').insertOne(held);
        await door.raiseVersionTo(S, 5);
        await deliver[via]([arriving('c', 5), entry('control', 9, {})]);
        await door.settled();
        const now = await door.coll(S, 'chrono').findOne({ _id: 'c' });
        assert.deepEqual(now, held, `${via}: the stored copy changed (a write, or a replace, of a copy that is the same)`);
        assert.equal(await door.coll(S, 'chrono').countDocuments({ forkOf: { $exists: true } }), 0, `${via}: the equal-seq copy was forked`);
        assert.equal(await door.coll(S, 'tombstones').countDocuments({}), 0, `${via}: a tombstone appeared`);
        const control = await door.coll(S, 'chrono').findOne({ _id: 'control' });
        assert.ok(control, `${via}: the control entry at seq 9 did not land, so "nothing was written" says nothing about the redacted copy`);
        assert.equal(await door.coll(S, 'chrono').countDocuments({}), 2, `${via}: a row other than the held entry and the control exists`);
      });
    }
  }

  /*
   * The control, INVERTED (Q-624, test 12). It used to say that a copy at one seq differing by a field outside the redaction list
   * leaves the stored row alone, "chrono never forks at one seq". Every kind forks now (D-23): a copy that differs in the title is a
   * DIVERGENCE even when redaction is also on one side, so it is kept as a fork beside the stored row, which stays exactly as it was.
   * "A redacted copy of the same entry is the same copy. A redacted copy that also differs in `title` forks" (design section 2).
   */
  for (const via of Object.keys(deliver)) {
    for (const [what, stored, arriving] of [
      ['a stored redacted copy meets an arriving full copy that also differs in its title', redacted, full],
      ['a stored full copy meets an arriving redacted copy that also differs in its title', full, redacted],
    ]) {
      it(`${via}: ${what} — it forks, and the stored row is untouched`, async () => {
        await door.reset();
        const held = { ...stored('c', 5), ...LOCAL };
        await door.coll(S, 'chrono').insertOne(held);
        await door.raiseVersionTo(S, 5);
        await deliver[via]([{ ...arriving('c', 5), title: 'another title' }]);
        await door.settled();
        assert.deepEqual(await door.coll(S, 'chrono').findOne({ _id: 'c' }), held, `${via}: the stored copy changed`);
        const forks = await door.coll(S, 'chrono').find({ forkOf: 'c' }).toArray();
        assert.equal(forks.length, 1, `${via}: a copy that differs in its title was not kept as a fork (${forks.length} fork rows); redaction hides detail, never a different title`);
        assert.equal(forks[0].title, 'another title');
      });
    }
  }

  /**
 * A fork is a record like any other where retention is concerned (Q-624, design section 4 "Fork write", section 3 "Redacted chrono
 * forks", and the probe's R14): the sweep that redacts a lapsed content window selects rows by their OWN retention stamp, with no
 * `forkOf` filter, so a fork that landed past its window is redacted on the next sweep, a marked fork is redacted alike and keeps its
 * mark, and a fork that arrives already redacted is admitted although its id can no longer be derived from the bytes redaction removed.
 */
  describe('a fork is redacted by its own retention stamp, and a redacted fork arrives', () => {
  const WRITTEN_THEN = '2025-03-04T05:06:07.000Z';
  let rdoor; let sweep;
  before(async () => {
    rdoor = door;
    ({ redactLapsedChronoContent: sweep } = await import('../../server/dist/brain/chrono-redaction.js'));
  });
  const doc = (id, seq, extra) => build.chrono(SR, id, seq, { author: { ...PEER_AUTHOR }, description: 'the detail', ...extra });
  const batch = (docs) => rdoor.push('/batch-upsert', { chrono: docs }, { spaceId: SR, networkId: rdoor.NET, token: TOKEN });

  it('a fork that landed past its content window is redacted on the next sweep, its title kept', async () => {
    await rdoor.reset();
    await rdoor.coll(SR, 'chrono').insertOne(doc('c', 5, { title: 'mine' }));
    await rdoor.raiseVersionTo(SR, 5);
    await batch([doc('c', 5, { title: 'theirs', createdAt: WRITTEN_THEN, updatedAt: WRITTEN_THEN })]);
    const fork = await rdoor.coll(SR, 'chrono').findOne({ forkOf: 'c' });
    assert.ok(fork, 'the divergent copy was not forked, so there is no fork to redact');
    assert.ok(fork._contentExpireAt instanceof Date && fork._contentExpireAt < new Date(),
      `the fork was not stamped from its own createdAt (${fork._contentExpireAt}): a fork past its window must be due at once (D-9)`);
    assert.equal(await sweep(SR, new Date()), 1, 'the sweep did not select the fork by its own retention stamp');
    const after = await rdoor.coll(SR, 'chrono').findOne({ _id: fork._id });
    assert.deepEqual([after.contentRedacted, after.description, after.title], [true, undefined, 'theirs']);
  });

  it('the sweep has no forkOf filter: a fork row stamped as due is redacted, and a mark on it survives', async () => {
    await rdoor.reset();
    const mark = [{ by: 'instance-a', at: '2026-10-01T00:00:00.000Z', seq: 9, proven: true }];
    await rdoor.coll(SR, 'chrono').insertMany([
      doc('c', 5, { title: 'mine' }),
      doc('c-fork', 5, { title: 'theirs', forkOf: 'c', _contentExpireAt: new Date('2025-04-01T00:00:00.000Z'), _resolvedElsewhere: mark }),
    ]);
    assert.equal(await sweep(SR, new Date()), 1);
    const fork = await rdoor.coll(SR, 'chrono').findOne({ _id: 'c-fork' });
    assert.deepEqual([fork.contentRedacted, fork.description, fork.forkOf], [true, undefined, 'c']);
    assert.deepEqual(fork._resolvedElsewhere, mark, 'redaction removed or changed the mark of a decision still owed here');
  });

  it('a fork that arrives ALREADY redacted is admitted as unverifiable, where one with an underivable id and its bytes is invalidFork', async () => {
    await rdoor.reset();
    await rdoor.coll(SR, 'chrono').insertOne(doc('c', 5, { title: 'mine' }));
    await rdoor.raiseVersionTo(SR, 5);
    // The sender's copy lost `description` to ITS redaction after the id was derived from it: the id cannot be recomputed from what is left.
    const gone = { ...doc('redacted-fork', 5, { title: 'theirs', forkOf: 'c', forkAt: 5, contentRedacted: true, contentRedactedAt: REDACTED_AT }) };
    delete gone.description;
    const bare = doc('bare-bad-fork', 5, { title: 'theirs again', forkOf: 'c', forkAt: 5 });
    const r = await batch([gone, bare]);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const stored = await rdoor.coll(SR, 'chrono').find({ forkOf: 'c' }).sort({ _id: 1 }).toArray();
    assert.deepEqual(stored.map(d => d._id), ['redacted-fork'], `stored forks: ${JSON.stringify(stored.map(d => d._id))}`);
    assert.equal(r.body.chrono.unverifiable, 1, `the redacted fork was not counted as unverifiable: ${JSON.stringify(r.body.chrono)}`);
    assert.equal(r.body.chrono.invalidFork, 1, `the unredacted fork whose id does not derive was not counted invalidFork: ${JSON.stringify(r.body.chrono)}`);
  });
});
});
