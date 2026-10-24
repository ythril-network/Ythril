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
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const REDACTED_AT = '2026-09-01T00:00:00.000Z';
const LOCAL = { pos: 424_242, posAtSeq: 5, deliveredBy: 'someone-who-delivered-it' };

describe('a redacted copy is the same copy', { skip }, () => {
  let door; let REDACTED_FIELDS;
  before(async () => {
    door = await openPullDoor({ suite: 'b81tD_redact', spaces: [S] });
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

  it('the control a case relies on: a copy at one seq that differs by a field outside the redaction list is not "the same" by this rule', async () => {
    await door.reset();
    const held = { ...redacted('c', 5), ...LOCAL };
    await door.coll(S, 'chrono').insertOne(held);
    await door.raiseVersionTo(S, 5);
    // Not a redaction: the title differs. Chrono never forks at one seq, so this too leaves the stored row alone — the rule above is
    // about WHICH copies count as the same, and for chrono both answers are "no write"; a fact would fork here (`divergesFrom`).
    await deliver.batch([{ ...full('c', 5), title: 'another title' }]);
    await door.settled();
    assert.deepEqual(await door.coll(S, 'chrono').findOne({ _id: 'c' }), held);
  });
});
