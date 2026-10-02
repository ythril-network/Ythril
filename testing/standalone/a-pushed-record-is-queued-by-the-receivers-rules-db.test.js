/**
 * A record that arrives by PUSH is offered to this instance's embedder by this instance's rules — on both push
 * doors, for every family that embeds (`Q-107` part 1, and the owner's ruling recorded in `CLAUDE.md`, *What a
 * receiver does after the write*).
 *
 * ## The defect this file was written red for
 *
 * The single `POST /api/sync/entities` route writes a NEW entity with a raw `$setOnInsert` and only reaches
 * `ingestBrainDoc` when the incoming seq is HIGHER than the copy it has just inserted — which it never is. So a
 * new entity pushed singly is stored and never queued: no vector on this instance, absent from every
 * meaning-ranked search, and nothing reports it. The other three single routes and the batch door queue.
 *
 * ## The rule, as a truth table per door
 *
 * Whether to queue is `record > schema > space`, resolved against THIS instance's configuration
 * (`embeddingSuppressedFor`), and a queued arrival goes on the BACKGROUND lane. Asserted per door and per family,
 * because a rule held on one door is the defect this repo produces most:
 *
 * | space        | record mark | type schema            | queued? |
 * |--------------|-------------|------------------------|---------|
 * | open         | —           | none                   | yes     |
 * | open         | true        | none                   | no      |
 * | open         | —           | quiet (suppress: true) | no      |
 * | open         | false       | quiet (suppress: true) | no      |  (`false` is "not stated")
 * | muted        | —           | none                   | no      |
 * | muted        | —           | loud (suppress: false) | yes     |
 *
 * Every row is a NEW record, so the single /entities defect shows on the two "yes" rows and nowhere else.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-pushed-record-is-queued-by-the-receivers-rules-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();

const OPEN = 'emb-open';
const MUTED = 'emb-muted';
/** The family's type field, as the suppression resolver keys the schema tier (`TYPE_FIELD`): an edge keys on label. */
const TYPE_KEY = { fact: 'type', entity: 'type', edge: 'label', chrono: 'type' };
/*
 * A space that declares chrono types allows ONLY those (plus nothing of the built-in vocabulary), so the default
 * `event` is declared too, with no suppression of its own — otherwise the untyped rows would be refused as an
 * unknown type rather than testing the space tier.
 */
const schemas = (name, suppressEmbeddings) =>
  Object.fromEntries(Object.keys(TYPE_KEY).map(t => [t, { [name]: { suppressEmbeddings }, ...(t === 'chrono' ? { event: {} } : {}) }]));

const ROWS = [
  { space: OPEN,  mark: undefined, type: undefined, queued: true,  label: 'open space, nothing stated' },
  { space: OPEN,  mark: true,      type: undefined, queued: false, label: 'record marked never-embed' },
  { space: OPEN,  mark: undefined, type: 'quiet',   queued: false, label: 'type schema suppresses' },
  { space: OPEN,  mark: false,     type: 'quiet',   queued: false, label: 'record false is not stated; the schema decides' },
  { space: MUTED, mark: undefined, type: undefined, queued: false, label: 'space suppresses' },
  { space: MUTED, mark: undefined, type: 'loud',    queued: true,  label: 'type schema overrides a suppressed space' },
];

const EMBEDDING_FAMILIES = Object.entries(FAMILIES).filter(([, f]) => f.single && f.type).map(([key, f]) => ({ key, ...f }));

let door, BACKGROUND;
let n = 0;

function arrival(fam, row) {
  const id = `${fam.type}-${++n}`;
  const extra = {};
  if (row.mark !== undefined) extra.suppressEmbeddings = row.mark;
  if (row.type !== undefined) extra[TYPE_KEY[fam.type]] = row.type;
  return build[fam.type](row.space, id, 10 + n, extra);
}

describe('a pushed record is queued for embedding by the receiver\'s rules', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushembed', spaces: [
      { id: OPEN, label: 'Open', folders: [], meta: { typeSchemas: schemas('quiet', true) } },
      { id: MUTED, label: 'Muted', folders: [], meta: { suppressEmbeddings: true, typeSchemas: schemas('loud', false) } },
    ] });
    ({ EMBED_PRIORITY: { background: BACKGROUND } } = await import('../../server/dist/brain/embed-queue.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(OPEN); await door.wipe(MUTED); });

  it('the family set is the four that embed, so an empty table cannot pass', () => {
    assert.deepEqual(EMBEDDING_FAMILIES.map(f => f.type).sort(), Object.keys(TYPE_KEY).sort());
  });

  it('a NEW entity pushed on the single /entities route is queued (the headline defect)', async () => {
    const doc = build.entity(OPEN, 'e-new', 7);
    const r = await door.push('/entities', doc, { spaceId: OPEN });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.ok(await door.coll(OPEN, 'entities').findOne({ _id: 'e-new' }), 'the entity was not stored');
    const job = await door.coll(OPEN, 'embed_jobs').findOne({ _id: 'entity:e-new' });
    assert.ok(job,
      'a new entity pushed singly was stored and never queued: it has no vector on this instance and is absent '
      + 'from every meaning-ranked search, with nothing to report it');
    assert.equal(job.priority, BACKGROUND, 'an arrival is not a write anybody here is waiting on: background lane');
  });

  for (const door_ of ['single', 'batch']) {
    describe(`${door_} door`, () => {
      for (const fam of EMBEDDING_FAMILIES) {
        for (const row of ROWS) {
          it(`${fam.type}: ${row.label} -> ${row.queued ? 'queued' : 'not queued'}`, async () => {
            const doc = arrival(fam, row);
            const r = door_ === 'single'
              ? await door.push(fam.single, doc, { spaceId: row.space })
              : await door.push('/batch-upsert', { [fam.key]: [doc] }, { spaceId: row.space });
            assert.equal(r.code, 200, JSON.stringify(r.body));
            assert.ok(await door.coll(row.space, fam.coll).findOne({ _id: doc._id }), `the ${fam.type} was not stored`);
            const job = await door.coll(row.space, 'embed_jobs').findOne({ _id: `${fam.type}:${doc._id}` });
            if (row.queued) {
              assert.ok(job, `${door_} ${fam.type} (${row.label}) was stored and not queued for embedding`);
              assert.equal(job.priority, BACKGROUND, `${door_} ${fam.type}: queued on the wrong lane`);
            } else {
              assert.equal(job, null, `${door_} ${fam.type} (${row.label}) was queued against the receiver's suppression`);
            }
          });
        }
      }
    });
  }
});
