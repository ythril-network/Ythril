/**
 * The TTL sweep heals a retention stamp that is stored as anything but a Date, on every family that expires (Q-223; bundle-40 plan R3).
 *
 * ## The defect it prevents
 *
 * An import before this change stored a restored stamp as it came: as text the import could not read, as a number, as an EJSON object,
 * as a boolean. A stored stamp that is not a BSON Date never matches `{ _expireAt: { $lte: now } }`, so the record is skipped by every
 * sweep for ever: a window the operator set never reaches it, silently. The rows are already stored, so fixing the import is not
 * enough. `_expireAt` and `_contentExpireAt` are local-only fields (never replicated), so a pass in the sweep may repair them in place,
 * with no marker and no boot migration.
 *
 * ## The rule (plan R3, with the revision-3 amendments)
 *
 * One cycle of `sweepExpired`, over every collection the sweep walks (`TTL_COLLECTIONS`, derived), for each stored stamp that is not a
 * Date, in `_expireAt` and, on chrono, `_contentExpireAt`:
 *
 *  - a string `retentionStampOf` accepts (explicit zone, real components) becomes the Date it names, an offset form included;
 *  - anything else (a number, an object, a boolean, a zone-less string, a rolled date) is restamped the way D-9 stamps an unstamped
 *    record: from the record's OWN `createdAt` by this instance's `schema > space` window (a chrono `event` here has a content window
 *    too). It is never left, and never bare-unset (a bare unset would make a record the operator meant to expire immortal);
 *  - a stamp that heals to a past instant is deleted by the cycle after it, through the normal delete (an expired record the heal made due);
 *  - **the heal's write is guarded on the stamp it read**: a Date written between the heal's read and its write wins.
 *
 * Instants are built with `Date.UTC` and compared by `getTime()`, never rendered in the runner's zone.
 *
 * ## Seen red
 *
 * On the base nothing reads a non-Date stamp: every seeded stamp is still its original shape after the cycle, and the guarded write
 * the concurrent-write case waits for never happens.
 *
 * Run: node --test testing/standalone/the-sweep-heals-a-stored-retention-stamp-that-is-not-a-date-db.test.js
 * (requires a prior `npm run build:server` and the harness Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'stamp-heal';
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const CONTENT_DAYS = 14;
const sha = (s) => createHash('sha256').update(s).digest('hex');

let acts, door, ttl, loader, importMod, ttlCollections;

/** The kind of row `build.*` makes for each swept collection. */
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', files: 'filemeta' };
/**
 * Tell the heal that something that can store a stamp ran since the last cycle, the way production does: through an import.
 *
 * ## What it prevents
 *
 * The heal sets a per-process latch on a collection it found clean and only an import resets it (plan R3, revision 3). These cases
 * seed rows with a direct insert (an import could not store them: the import is what this change stops from doing), so a latch an
 * earlier case set would leave the later seeds unseen, and the cases would pass or fail on the order they run in. One harmless
 * import into every swept collection, after the seed, is what resets it for whatever way the implementation scopes the reset.
 */
async function aStampWasStored(tag) {
  for (const c of ttlCollections) {
    const id = idOf(c, `latch-reset-${tag}`);
    await importMod.importDocuments(S, { [c]: [build[KIND[c]](S, id, 40)] });
  }
}

/** The row builder of each swept collection; `created` is the record's own createdAt (an ISO string). */
const rowOf = {
  facts: (id, created, extra) => build.fact(S, id, 5, { createdAt: created, updatedAt: created, ...extra }),
  entities: (id, created, extra) => build.entity(S, id, 5, { createdAt: created, updatedAt: created, ...extra }),
  edges: (id, created, extra) => build.edge(S, id, 5, { createdAt: created, updatedAt: created, ...extra }),
  chrono: (id, created, extra) => build.chrono(S, id, 5, { createdAt: created, updatedAt: created, startsAt: created, ...extra }),
  files: (id, created, extra) => build.filemeta(S, id, 5, { createdAt: created, updatedAt: created, sizeBytes: 3, sha256: sha('abc'), ...extra }),
};
const idOf = (c, tag) => (c === 'files' ? `docs/${tag}.md` : `${c}-${tag}`);
const fieldsOf = (c) => (c === 'chrono' ? ['_expireAt', '_contentExpireAt'] : ['_expireAt']);
const show = (v) => (v instanceof Date ? `Date(${v.toISOString()})` : JSON.stringify(v));
const stored = (c, id) => door.coll(S, c).findOne({ _id: id });

/**
 * The shapes a stored stamp may have, each with what one cycle must make of it. `make(field)` is what is stored;
 * `want(field, createdMs)` is the instant the healed stamp holds.
 */
const FUTURE = { _expireAt: Date.UTC(2031, 5, 7, 8, 9, 10), _contentExpireAt: Date.UTC(2031, 4, 7, 8, 9, 10) };
const windowOf = (field) => (field === '_expireAt' ? WINDOW_DAYS : CONTENT_DAYS) * DAY;
const restamped = (field, createdMs) => createdMs + windowOf(field);
const SHAPES = [
  { tag: 'z-string', make: f => new Date(FUTURE[f]).toISOString(), want: f => FUTURE[f] },
  { tag: 'offset-string', make: f => `${new Date(FUTURE[f] + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`, want: f => FUTURE[f] },
  { tag: 'zoneless-string', make: f => new Date(FUTURE[f]).toISOString().slice(0, 19), want: restamped },
  { tag: 'rolled-string', make: () => '2031-02-30T00:00:00Z', want: restamped },
  { tag: 'number', make: f => FUTURE[f], want: restamped },
  { tag: 'ejson-object', make: f => ({ $date: new Date(FUTURE[f]).toISOString() }), want: restamped },
  { tag: 'boolean', make: () => true, want: restamped },
];

const spaceConfig = () => loader.getConfig().spaces.find(s => s.id === S);

describe('the TTL sweep heals a stored retention stamp that is not a Date (Q-223)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'stamp-heal', space: S });
    ({ door } = acts);
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    loader = await import('../../server/dist/config/loader.js');
    importMod = await import('../../server/dist/sync/space-import.js');
    ({ TTL_COLLECTIONS: ttlCollections } = await import('../../server/dist/brain/ttl.js'));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    fs.rmSync(acts.root(), { recursive: true, force: true });
    const cfg = spaceConfig();
    cfg.recordTtlDays = WINDOW_DAYS;
    cfg.meta = { ...cfg.meta, typeSchemas: { chrono: { event: { retention: { days: WINDOW_DAYS, contentDays: CONTENT_DAYS } } } } };
  });

  it('the swept collections are derived and the shape table is not empty', () => {
    assert.ok(ttlCollections.length >= 5, `only ${ttlCollections.length} swept collections`);
    for (const c of ttlCollections) assert.ok(rowOf[c], `no fixture row for the swept collection '${c}'`);
    assert.ok(SHAPES.length >= 7);
  });

  it('after one cycle every stored stamp that is not a Date is a Date on every swept collection: a string the rule accepts as the instant it names, any other shape restamped from createdAt by the resolved window', async () => {
    const createdMs = Date.now() - DAY;
    const created = new Date(createdMs).toISOString();
    const seeded = [];
    for (const c of ttlCollections) {
      for (const shape of SHAPES) {
        const id = idOf(c, shape.tag);
        const extra = Object.fromEntries(fieldsOf(c).map(f => [f, shape.make(f)]));
        await door.coll(S, c).insertOne(rowOf[c](id, created, extra));
        seeded.push({ c, id, shape });
      }
    }
    assert.equal(seeded.length, ttlCollections.length * SHAPES.length);
    await aStampWasStored('shapes');

    await ttl.sweepExpired(new Date());

    const wrong = [];
    for (const { c, id, shape } of seeded) {
      const row = await stored(c, id);
      if (!row) { wrong.push(`${c}/${id}: the record is gone (its stamp was in the future)`); continue; }
      for (const f of fieldsOf(c)) {
        const got = row[f];
        const want = shape.want(f, createdMs);
        if (!(got instanceof Date)) wrong.push(`${c}/${id} (${shape.tag}): ${f} is still ${show(got)}, want ${new Date(want).toISOString()}`);
        else if (got.getTime() !== want) wrong.push(`${c}/${id} (${shape.tag}): ${f} ${got.toISOString()}, want ${new Date(want).toISOString()}`);
      }
    }
    assert.deepEqual(wrong, [], 'a stamp that is not a Date was left, or healed to the wrong instant: its record never expires, or expires at a date nobody set');
  });

  it('a record whose stamp is already a Date is not touched by the heal (control)', async () => {
    const created = new Date(Date.now() - DAY).toISOString();
    const keep = new Date(Date.UTC(2040, 0, 1));
    for (const c of ttlCollections) {
      await door.coll(S, c).insertOne(rowOf[c](idOf(c, 'date'), created, Object.fromEntries(fieldsOf(c).map(f => [f, keep]))));
    }
    await ttl.sweepExpired(new Date());
    const wrong = [];
    for (const c of ttlCollections) {
      const row = await stored(c, idOf(c, 'date'));
      for (const f of fieldsOf(c)) if (row?.[f]?.getTime?.() !== keep.getTime()) wrong.push(`${c}: ${f} ${show(row?.[f])}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('a stamp that heals to a past instant is deleted by the following cycle, on every swept collection', async () => {
    const created = new Date(Date.now() - DAY).toISOString();
    const past = '2020-01-01T00:00:00.000Z';
    const ids = [];
    for (const c of ttlCollections) {
      const id = idOf(c, 'past-due');
      if (c === 'files') {
        const abs = path.join(acts.root(), id);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'abc');
      }
      await door.coll(S, c).insertOne(rowOf[c](id, created, Object.fromEntries(fieldsOf(c).map(f => [f, past]))));
      ids.push([c, id]);
    }
    await aStampWasStored('past');

    await ttl.sweepExpired(new Date());
    // After the first cycle a record is either already deleted, or it carries the healed stamp as a Date: never the text it was stored as.
    const text = [];
    for (const [c, id] of ids) {
      const row = await stored(c, id);
      if (row && !(row._expireAt instanceof Date)) text.push(`${c}/${id}: _expireAt is still ${show(row._expireAt)} after a cycle`);
    }
    assert.deepEqual(text, [], 'the first cycle left a stamp that is not a Date');

    await ttl.sweepExpired(new Date());
    const left = [];
    for (const [c, id] of ids) if (await stored(c, id)) left.push(`${c}/${id}`);
    assert.deepEqual(left, [], 'a record whose stamp healed to the past was not deleted by the cycle after the heal');
  });

  it('a Date written between the heal\'s read and its write wins: the heal\'s write is guarded on the stamp it read', async () => {
    const created = new Date(Date.now() - DAY).toISOString();
    const text = '2031-06-07T08:09:10.123Z';
    const winner = new Date(Date.UTC(2035, 0, 1));
    const id = idOf('facts', 'race');
    await door.coll(S, 'facts').insertOne(rowOf.facts(id, created, { _expireAt: text }));
    await aStampWasStored('race');

    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const park = parkWrites(proto);
    try {
      // Park the first write on the facts collection that names the stored text: the heal's, whichever driver method it uses.
      const mentionsText = (_method, args) => {
        try { return JSON.stringify(args.slice(0, 2)).includes(text); } catch { return false; }
      };
      const heal = park.arm(`${S}_facts`, { count: 1, when: mentionsText });
      const sweep = ttl.sweepExpired(new Date());
      const first = await Promise.race([heal.reached.then(() => 'parked'), sweep.then(() => 'the sweep ended')]);
      try {
        assert.equal(first, 'parked', 'the sweep ended without writing a stamp it had read as text: nothing heals a stored stamp that is not a Date');
        // The concurrent write: a local edit gives the record a real Date between the heal's read and its write.
        await door.coll(S, 'facts').updateOne({ _id: id }, { $set: { _expireAt: winner } });
      } finally {
        heal.release();
      }
      await sweep;
    } finally {
      park.restore();
    }
    const row = await stored('facts', id);
    assert.ok(row, 'the record was deleted');
    assert.equal(row._expireAt?.getTime?.(), winner.getTime(), `the heal overwrote a Date written after its read: _expireAt is ${show(row._expireAt)}`);
  });
});
