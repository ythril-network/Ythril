/**
 * An import never stores a retention stamp that is not a Date: a stamp of any other shape is dropped, so D-9 stamps the record
 * from its own `createdAt` (Q-268; bundle-40 plan R3, which makes `retentionStampOf` the rule `prepared()` asks for every family).
 *
 * ## The defect it prevents
 *
 * `prepared()` (sync/arrivals.ts) turns a restored STRING stamp into a Date and lets every other shape through untouched. A backup
 * that carries `_expireAt` as a number, as an EJSON `{"$date": ...}` object, as a boolean or as null therefore lands that value in the
 * store, and a stored stamp that is not a BSON Date never matches the sweep's `{ _expireAt: { $lte: now } }`: the restored record
 * never expires, for as long as it is stored, and nothing says so. (A string that no component rule accepts is turned into a Date by
 * `new Date(text)`, which rolls 2020-02-30 to March 1 and reads a zone-less string in the runner's zone: a wrong date, stored.)
 *
 * ## The rule
 *
 * Over every family the import restores that carries retention (derived from `REPLICATED_FAMILIES` and `RECORD_TYPE_OF`, never listed):
 *
 *  - a `_expireAt` or `_contentExpireAt` that is a number, an object, a boolean or null is dropped: nothing but a Date or nothing is
 *    stored, and the record is stamped as an unstamped one is, D-9, from its own `createdAt` by this instance's `schema > space`
 *    window (a chrono `event` here has a content window too; no other family has one, so its `_contentExpireAt` stays absent);
 *  - a string with no explicit zone, or one that rolls (2030-02-30), is dropped the same way;
 *  - PIN (green on the base): a string with an explicit zone and a real date is kept as the instant it names, an offset one included.
 *
 * Every instant is compared by `getTime()` against one built with `Date.UTC`; nothing is rendered in the runner's zone.
 *
 * ## Seen red
 *
 * On the base the non-Date shapes are stored as they came (the number, the object, the boolean, null), and the rolled string is stored
 * as the next month's Date.
 *
 * Run: node --test testing/standalone/an-import-drops-a-retention-stamp-that-is-not-a-date-db.test.js
 * (requires a prior `npm run build:server` and the harness Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'import-stamp-shapes';
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const CONTENT_DAYS = 14;
/** `build.*`'s createdAt: D-9 stamps from it. */
const CREATED = Date.UTC(2026, 8, 1);
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', files: 'filemeta' };

let door, importMod, families;

/** Every family the import restores that carries retention (a link carries none). */
const stamped = () => families.filter(f => f.recordType !== null);
const idFor = (fam, tag) => (fam.collection === 'files' ? `docs/${tag}.md` : `${fam.collection}-${tag}`);
const backupOf = (fam, id, extra = {}) => build[KIND[fam.collection]](S, id, 40, extra);
const show = (v) => (v instanceof Date ? `Date(${v.toISOString()})` : JSON.stringify(v));

/** What D-9 gives a record created at CREATED under this space's policy: the window of every family, and the content window of chrono. */
const d9 = (fam) => ({
  _expireAt: CREATED + WINDOW_DAYS * DAY,
  _contentExpireAt: fam.collection === 'chrono' ? CREATED + CONTENT_DAYS * DAY : undefined,
});

/** [tag, what the backup carries]: shapes that are not a Date and not a string. */
const NOT_A_DATE = [
  ['number', 1893456000000],
  ['ejson-date', { $date: '2030-01-01T00:00:00.000Z' }],
  ['ejson-number-long', { $date: { $numberLong: '1893456000000' } }],
  ['boolean-true', true],
  ['boolean-false', false],
  ['null', null],
];

/** [tag, string]: text that no component rule accepts as an instant with an explicit zone. */
const NOT_AN_INSTANT = [
  ['zone-less', '2030-01-01T00:00:00'],
  ['rolled', '2030-02-30T00:00:00Z'],
  ['hour-24', '2030-01-01T24:00:00Z'],
];

/** The stored stamps of one record, as a list of what is wrong with them against what D-9 gives. */
async function wrongStamps(fam, id) {
  const row = await door.coll(S, fam.collection).findOne({ _id: id });
  if (!row || row.seq !== 40) return [`${fam.collection}/${id}: fixture check - the restore did not land`];
  const want = d9(fam);
  const wrong = [];
  for (const f of ['_expireAt', '_contentExpireAt']) {
    const got = row[f];
    if (got !== undefined && !(got instanceof Date)) wrong.push(`${fam.collection}/${id}: ${f} is stored as ${show(got)}, not a Date`);
    else if (want[f] === undefined && got !== undefined) wrong.push(`${fam.collection}/${id}: ${f} ${show(got)}, want none (no content window outside chrono)`);
    else if (want[f] !== undefined && got?.getTime?.() !== want[f]) {
      wrong.push(`${fam.collection}/${id}: ${f} ${show(got)}, want D-9's ${new Date(want[f]).toISOString()}`);
    }
  }
  return wrong;
}

describe('an import drops a retention stamp that is not a Date (Q-268)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'import-stamp-shapes', spaces: [{
      id: S, label: 'Import stamp shapes', folders: [], recordTtlDays: WINDOW_DAYS,
      meta: { typeSchemas: { chrono: { event: { retention: { days: WINDOW_DAYS, contentDays: CONTENT_DAYS } } } } },
    }] });
    importMod = await import('../../server/dist/api/admin-import.js');
    const { REPLICATED_FAMILIES, RECORD_TYPE_OF } = await import('../../server/dist/sync/replicated-families.js');
    families = REPLICATED_FAMILIES.map(f => ({ collection: f.collection, recordType: RECORD_TYPE_OF[f.collection] }));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the families are derived and the tables are not empty', () => {
    assert.ok(stamped().length >= 5, `only ${stamped().length} stamped families`);
    assert.ok(stamped().some(f => f.collection === 'chrono') && stamped().some(f => f.collection === 'files'));
    assert.ok(NOT_A_DATE.length >= 5 && NOT_AN_INSTANT.length >= 3);
  });

  it('PIN (the fixture check): a record imported with no stamp at all is stamped the D-9 way, so the values the cases below expect are the ones this space gives', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      const id = idFor(fam, 'unstamped');
      await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id)] });
      wrong.push(...await wrongStamps(fam, id));
    }
    assert.deepEqual(wrong, []);
  });

  it('a number, an EJSON {"$date": ...} object, a boolean or null in _expireAt and _contentExpireAt is dropped on every family, and D-9 stamps the record', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      for (const [tag, value] of NOT_A_DATE) {
        const id = idFor(fam, `shape-${tag}`);
        await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id, { _expireAt: value, _contentExpireAt: value })] });
        wrong.push(...await wrongStamps(fam, id));
      }
    }
    assert.deepEqual(wrong, [], 'an import stored a retention stamp that is not a Date: the record never matches the sweep and never expires');
  });

  it('the same holds when the stored copy it replaces carries a stamp: the backup\'s bad shape never becomes the stored one, and the replaced copy\'s is not kept either', async () => {
    const wrong = [];
    const replaced = new Date(Date.UTC(2099, 0, 1));
    for (const fam of stamped()) {
      const id = idFor(fam, 'over-stored');
      await door.coll(S, fam.collection).insertOne({ ...backupOf(fam, id), seq: 39, _expireAt: replaced, _contentExpireAt: replaced });
      await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id, { _expireAt: 1893456000000, _contentExpireAt: { $date: '2030-01-01T00:00:00.000Z' } })] });
      wrong.push(...await wrongStamps(fam, id));
    }
    assert.deepEqual(wrong, [], 'a restore over a stored copy stored a stamp that is not a Date, or kept the replaced copy\'s');
  });

  it('a string with no explicit zone, a rolled date or T24:00 is dropped on every family, and D-9 stamps the record', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      for (const [tag, text] of NOT_AN_INSTANT) {
        const id = idFor(fam, `text-${tag}`);
        await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id, { _expireAt: text, _contentExpireAt: text })] });
        wrong.push(...await wrongStamps(fam, id));
      }
    }
    assert.deepEqual(wrong, [], 'an import stored a date it guessed from text no rule accepts (a rolled month, or an instant that depends on the runner\'s zone)');
  });

  it('PIN: a string with an explicit zone and a real date is kept as the instant it names, an offset and fractional seconds included', async () => {
    const cases = [
      ['z', '2031-03-04T05:06:07Z', Date.UTC(2031, 2, 4, 5, 6, 7)],
      ['offset', '2031-03-04T05:06:07+02:00', Date.UTC(2031, 2, 4, 3, 6, 7)],
      ['negative-offset', '2031-03-04T05:06:07-05:30', Date.UTC(2031, 2, 4, 10, 36, 7)],
      ['fraction', '2031-03-04T05:06:07.089Z', Date.UTC(2031, 2, 4, 5, 6, 7, 89)],
    ];
    const wrong = [];
    for (const fam of stamped()) {
      for (const [tag, text, instant] of cases) {
        const id = idFor(fam, `kept-${tag}`);
        await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id, { _expireAt: text, _contentExpireAt: text })] });
        const row = await door.coll(S, fam.collection).findOne({ _id: id });
        if (row?.seq !== 40) { wrong.push(`${fam.collection}/${id}: fixture check - the restore did not land`); continue; }
        if (row._expireAt?.getTime?.() !== instant) wrong.push(`${fam.collection}/${id}: _expireAt ${show(row._expireAt)}, want ${new Date(instant).toISOString()}`);
        // A content stamp is kept wherever the backup carried one (a restore keeps what the backup recorded, D-13).
        if (row._contentExpireAt !== undefined && row._contentExpireAt?.getTime?.() !== instant) {
          wrong.push(`${fam.collection}/${id}: _contentExpireAt ${show(row._contentExpireAt)}, want ${new Date(instant).toISOString()}`);
        }
      }
    }
    assert.deepEqual(wrong, [], 'a restore did not keep the instant the backup recorded');
  });
});
