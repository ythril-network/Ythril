/**
 * A change note that NAMES spaces this instance does not carry is stored, listed and fires no `change_note.received` webhook; a note that names
 * no space still tells every space of the network (bundle-106 R-X10d, webhook half; design v5 section 2.9 v5 (4), INT S4).
 *
 * ## What was true before
 *
 * `receiveChangeNotes` kept only the named spaces this instance carries, and then fanned the event out to `spaces.length ? spaces : net.spaces`. A
 * note whose named spaces were ALL filtered out looked exactly like a note that named none, so it was announced to EVERY space of the network. The
 * case that makes it real is the publisher's deletion notice (D-40): the publisher names the space it deleted; a subscriber that applied the
 * deletion before the note arrived no longer carries it, and every unrelated space's webhook was told that something happened to it.
 *
 * ## What holds now
 *
 * - **named, none carried:** the note is stored (`direction: 'in'`, `spaces: []`) and listed as before, and NO space's `change_note.received` fires;
 * - **named, some carried (control):** it fires once per carried space and for no other;
 * - **named none (control, the positive twin of the absence):** it fires for every space the network carries here - the same emit path, so the
 *   absence above is the rule and not a silent emitter.
 *
 * ## How it is observed
 *
 * `emitWebhookEvent` mirrors every event onto the in-process bus synchronously (`brain/brain-events.ts`), and the webhook dispatch is queued from
 * the same call, so the bus is the dispatch's own record and needs no subscription, delivery or timer. One listener per space of the network.
 *
 * ## Seen red
 *
 * On the base the named-but-uncarried note is announced to every space of the network. The controls pass on the base: they state what the change
 * keeps. After the fix, by hand: restore `spaces.length ? spaces : net.spaces` for a note that named spaces -> the first row red.
 *
 * Run: node --test testing/standalone/a-note-about-a-space-this-instance-lacks-fires-no-webhook-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { M1, tempInstance, networkOf, boot, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-note-webhook-');
const skip = await mongoSkipReason();

describe('a note about a space this instance lacks fires no webhook', { skip }, () => {
  let mongo; let bus; let receiveChangeNotes; let stop = [];
  before(async () => {
    mongo = await openTestMongo('note_webhook');
    await databaseTakesCollections(mongo);
    bus = await import('../../server/dist/brain/brain-events.js');
    ({ receiveChangeNotes } = await import('../../server/dist/sync/change-notes.js'));
  });
  after(async () => { stop.forEach(f => f()); await closeTestMongo(); removeInstanceDir(dir); });

  /** SELF as a subscriber of M1 carrying `general` and `other`; every carried space is listened to. */
  const subscriber = async () => {
    const loader = await boot(dir, { spaces: ['other'], networks: [networkOf('pubsub', [M1], { spaces: ['general', 'other'], extra: { origin: 'joined' }, memberExtra: { direction: 'pull' } })] });
    const heard = [];
    stop.forEach(f => f()); stop = ['general', 'other'].map(s => bus.subscribeBrainChanges(s, ev => { if (ev.event === 'change_note.received') heard.push(ev.spaceId); }));
    return { loader, heard };
  };
  const note = (spaces) => ({ id: randomUUID(), note: 'the publisher deleted the space', spaces, author: 'publisher', generated: true, createdAt: new Date().toISOString() });
  const receive = async (n) => {
    const res = await receiveChangeNotes('net-1', M1, { notes: [n] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.stored, 1, 'the note was not stored');
    return res;
  };

  it('a note that names spaces none of which is carried here is stored, and no space is told', async () => {
    const { heard } = await subscriber();
    const n = note(['gone-space']);
    await receive(n);
    const stored = await mongo.col('_change_notes').findOne({ _id: n.id });
    assert.ok(stored, 'the note is not stored');
    assert.deepEqual([stored.direction, stored.spaces], ['in', []]);
    assert.deepEqual(heard, [], `a note about a space this instance no longer carries told ${JSON.stringify(heard)}: every unrelated space's webhook hears about it`);
  });

  it('control: a note that names one carried space tells that space and no other', async () => {
    const { heard } = await subscriber();
    await receive(note(['other', 'gone-space']));
    assert.deepEqual(heard, ['other']);
  });

  it('twin: a note that names no space tells every space of the network carried here - the emit path works, so the absence above is the rule', async () => {
    const { heard } = await subscriber();
    await receive(note([]));
    assert.deepEqual([...heard].sort(), ['general', 'other']);
  });
});
