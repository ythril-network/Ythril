/**
 * A restore stores the BACKUP's record-tier fields — its retention stamps and `syncBase` — and never the replaced
 * copy's (Q-234, under owner decision D-9).
 *
 * ## The rule
 *
 * An admin import is a restore: what it writes is the backup's record, replacing whatever is stored. The writer
 * carried every local-only field of the stored copy across the replace, so a record whose backup carries NO stamp
 * kept the stamp of the copy it replaced — a record the operator restored to "never expires" went on expiring on
 * the replaced copy's date, and a `syncBase` the backup never had went on telling sync that this instance agreed a
 * version with a peer. A file's restore merged with `$set` and never `$unset`, with the same effect.
 *
 * So, per restored record (D-9 as it stands; D-13 is parked and does not change this):
 * - a field the backup carries is stored as the backup carried it (a stamp as a Date);
 * - a stamp the backup does not carry is D-9's: from the record's OWN `createdAt` by this instance's
 *   `schema > space` window, or absent where this instance gives none — never the replaced copy's;
 * - a `syncBase` the backup does not carry is absent.
 *
 * Sentinels: the replaced copy holds the epoch and 9999-12-31 as BSON Dates, values no D-9 window produces, so a
 * survivor is unmistakable.
 *
 * ## Seen red / pins
 *
 * On the base (0b066822) "the backup carries none" is red for every family: the replaced copy's sentinels and
 * `syncBase` survive. "The backup carries its own" and "no stored copy" are green on the base and are PINS: the
 * backup's values already win over the stored copy's, and D-9 already stamps an unstamped arrival.
 *
 * Run: node --test testing/standalone/a-restore-keeps-the-backups-stamps-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'restore-stamps';
const WINDOW_DAYS = 30;
const DAY = 86_400_000;
/** `build.*`'s createdAt: D-9 stamps from it. */
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const EPOCH = new Date(0);
const FAR = new Date('9999-12-31T23:59:59.999Z');
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', files: 'filemeta' };

let door, importMod, families, RESTORED;

/** Every family the import restores that carries record-tier fields (a link carries no retention). */
const stamped = () => families.filter(f => f.recordType !== null);
const idFor = (fam, tag) => (fam.collection === 'files' ? `docs/${tag}.md` : `${fam.collection}-${tag}`);
const backupOf = (fam, id, extra = {}) => build[KIND[fam.collection]](S, id, 40, extra);

const show = (v) => (v instanceof Date ? `Date(${v.toISOString()})` : JSON.stringify(v));

describe('a restore keeps the backup\'s stamps, never the replaced copy\'s (Q-234)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'restore-stamps', spaces: [{ id: S, label: 'Restore', folders: [], meta: {}, recordTtlDays: WINDOW_DAYS }] });
    importMod = await import('../../server/dist/api/admin-import.js');
    const { REPLICATED_FAMILIES, RECORD_TYPE_OF } = await import('../../server/dist/sync/replicated-families.js');
    families = REPLICATED_FAMILIES.map(f => ({ collection: f.collection, recordType: RECORD_TYPE_OF[f.collection] }));
    ({ RESTORED_LOCAL_FIELDS: RESTORED } = await import('../../server/dist/sync/local-only-fields.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the families and the record-tier fields are derived', () => {
    assert.ok(stamped().length >= 5, `only ${stamped().length} stamped families`);
    assert.deepEqual([...RESTORED].sort(), ['_contentExpireAt', '_expireAt', 'syncBase'],
      'RESTORED_LOCAL_FIELDS changed — give the new field a sentinel here before trusting this file');
  });

  it('the backup carries NONE: the replaced copy\'s sentinels and syncBase never survive; D-9 stamps from createdAt', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      for (const [tag, sentinel] of [['under-epoch', EPOCH], ['under-far', FAR]]) {
        const id = idFor(fam, `none-${tag}`);
        await door.coll(S, fam.collection).insertOne({ ...backupOf(fam, id), seq: 39,
          _expireAt: sentinel, _contentExpireAt: sentinel, syncBase: { 'replaced-peer': 'sha-of-the-replaced-copy' } });
        await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id)] });
        const after = await door.coll(S, fam.collection).findOne({ _id: id });
        if (after?.seq !== 40) { wrong.push(`${fam.collection}/${id}: fixture check — the restore did not land`); continue; }
        const d9 = new Date(T0 + WINDOW_DAYS * DAY);
        if (!isDeepStrictEqual(after._expireAt, d9)) wrong.push(`${fam.collection}/${id}: _expireAt ${show(after._expireAt)}, want D-9's ${show(d9)}`);
        if (isDeepStrictEqual(after._contentExpireAt, sentinel)) wrong.push(`${fam.collection}/${id}: _contentExpireAt is the replaced copy's ${show(sentinel)}`);
        if ('syncBase' in after) wrong.push(`${fam.collection}/${id}: syncBase ${show(after.syncBase)} — the backup carried none`);
      }
    }
    assert.deepEqual(wrong, [], 'a restore kept what the copy it REPLACED carried: the record expires on the replaced '
      + 'copy\'s date (or never), and sync believes a version was agreed that the backup never recorded');
  });

  it('PIN the backup carries its own: its stamps (as Dates) and its syncBase are stored, over either sentinel', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      for (const [stored, carried] of [[EPOCH, FAR], [FAR, EPOCH]]) {
        const id = idFor(fam, `own-${stored.getTime() === 0 ? 'epoch' : 'far'}`);
        await door.coll(S, fam.collection).insertOne({ ...backupOf(fam, id), seq: 39,
          _expireAt: stored, _contentExpireAt: stored, syncBase: { 'replaced-peer': 'sha-of-the-replaced-copy' } });
        const own = { 'backup-peer': 'sha-the-backup-recorded' };
        await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id, {
          _expireAt: carried.toISOString(), _contentExpireAt: carried.toISOString(), syncBase: own })] });
        const after = await door.coll(S, fam.collection).findOne({ _id: id });
        if (after?.seq !== 40) { wrong.push(`${fam.collection}/${id}: fixture check — the restore did not land`); continue; }
        for (const f of ['_expireAt', '_contentExpireAt']) {
          if (!isDeepStrictEqual(after[f], carried)) wrong.push(`${fam.collection}/${id}: ${f} ${show(after[f])}, want the backup's ${show(carried)}`);
        }
        if (!isDeepStrictEqual(after.syncBase, own)) wrong.push(`${fam.collection}/${id}: syncBase ${show(after.syncBase)}, want the backup's`);
      }
    }
    assert.deepEqual(wrong, [], 'a restore did not store what the backup carried');
  });

  it('PIN D-9: an unstamped record restored where nothing is stored is stamped from its own createdAt', async () => {
    const wrong = [];
    for (const fam of stamped()) {
      const id = idFor(fam, 'fresh');
      await importMod.importDocuments(S, { [fam.collection]: [backupOf(fam, id)] });
      const after = await door.coll(S, fam.collection).findOne({ _id: id });
      const d9 = new Date(T0 + WINDOW_DAYS * DAY);
      if (!isDeepStrictEqual(after?._expireAt, d9)) wrong.push(`${fam.collection}/${id}: _expireAt ${show(after?._expireAt)}, want ${show(d9)}`);
    }
    assert.deepEqual(wrong, [], 'an unstamped restored record is not stamped by this instance\'s retention (D-9)');
  });
});
