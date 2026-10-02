/**
 * A RESTORED record holds exactly the record-tier local fields its backup carried, and none it did not — `Q-218`
 * round R, item R2.
 *
 * ## The rule
 *
 * The admin import (`importDocuments`, through `writeArrivals(..., { restore: true })`) is this instance restoring its
 * own backup. The backup is the record's state: the record-tier local fields (`RESTORED_LOCAL_FIELDS` — the two
 * retention stamps and `syncBase`) are KEPT from it (`Q-205`). The other half of the same rule is that a field the
 * backup does NOT carry is not the record's state either: a stamp on the copy stored before the restore belongs to a
 * record the operator is replacing. Carried across the replace, it decides when the restored record is deleted (or
 * that a "never expire" record expires), and a stale `syncBase` decides which file divergences become conflicts.
 *
 * The writer's replace carries every local-only field from the stored copy (`replacementFor`), a restore included,
 * so a backup without a stamp is restored WITH the old copy's stamp.
 *
 * Over every family the import accepts (derived from `REPLICATED_FAMILIES`, with a floor) and every record-tier field
 * (read from the module):
 *
 *  - the backup lacks the field and the stored copy has it -> the restored record does NOT have it;
 *  - the backup carries the field -> the restored record has the BACKUP's value (control; `Q-205`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-restore-holds-only-what-the-backup-carried-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-restore-exact-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACE = 'restore-exact';
const T0 = '2026-06-01T00:00:00.000Z';
const author = { instanceId: 'origin', instanceLabel: 'Origin' };

/** One exported document per collection. A FIXTURE, literal on purpose; the derivation decides one is owed. */
function fixture(collection, id, seq) {
  const shapes = {
    facts: { fact: `fact ${id}` },
    entities: { name: `Entity ${id}`, type: 'concept', properties: {} },
    edges: { from: `from-${id}`, to: `to-${id}`, label: 'relates' },
    chrono: { title: `chrono ${id}`, type: 'event', startsAt: T0, status: 'upcoming' },
    links: { from: `src-${id}`, fromKind: 'fact', to: `dst-${id}`, toKind: 'entity', label: 'mentions' },
    files: { path: id },
  };
  assert.ok(shapes[collection], `no exported-document fixture for collection '${collection}' — add one`);
  return { _id: id, spaceId: SPACE, tags: [], author, createdAt: T0, updatedAt: T0, seq, ...shapes[collection] };
}

/** What the stored copy holds before the restore, and what a backup that carries the field holds. Values are fixtures. */
const STORED = { _expireAt: new Date('2027-01-01T00:00:00.000Z'), _contentExpireAt: new Date('2026-12-01T00:00:00.000Z'),
  syncBase: { 'old-peer': 'sha-before-the-restore' } };
const BACKUP = { _expireAt: '2099-01-01T00:00:00.000Z', _contentExpireAt: '2098-01-01T00:00:00.000Z',
  syncBase: { 'backup-peer': 'sha-in-the-backup' } };
const asStored = (f, v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' && f.startsWith('_') ? v : JSON.stringify(v));

let mongo, importDocuments, families, RECORD_TIER;
const coll = (c) => mongo.col(`${SPACE}_${c}`);

describe('a restored record holds only the record-tier local fields its backup carried', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ instanceId: 'restore-exact', instanceLabel: 'test',
      tokens: [], networks: [], spaces: [{ id: SPACE, label: 'Restore', folders: [], meta: {} }] }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    mongo = await openTestMongo('restoreexact');
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    ({ RESTORED_LOCAL_FIELDS: RECORD_TIER } = await import('../../server/dist/sync/local-only-fields.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => { for (const f of families) await coll(f.collection).deleteMany({}); });

  it('the families and the record-tier fields are read from the code, and every field has a fixture', () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families`);
    assert.ok(RECORD_TIER.size >= 3, `RESTORED_LOCAL_FIELDS: ${[...RECORD_TIER]}`);
    assert.deepEqual([...RECORD_TIER].filter(f => !(f in STORED) || !(f in BACKUP)), [], 'a record-tier field with no fixture');
  });

  it('every family, every record-tier field: the backup decides, present or absent', async () => {
    const wrong = [];
    for (const fam of families.map(f => f.collection)) {
      for (const f of RECORD_TIER) {
        for (const carried of [false, true]) {
          const id = `${fam}-${f}-${carried ? 'carried' : 'absent'}`;
          await coll(fam).insertOne({ ...fixture(fam, id, 5), [f]: STORED[f] });
          const backup = { ...fixture(fam, id, 9), ...(carried ? { [f]: BACKUP[f] } : {}) };
          const r = await importDocuments(SPACE, { [fam]: [backup] });
          assert.equal(r.results[fam].errors, 0, `${fam}/${id}: ${JSON.stringify(r.results[fam])}`);
          const after = await coll(fam).findOne({ _id: id });
          assert.equal(after?.seq, 9, `fixture check: ${fam}/${id} was not restored`);
          if (!carried && after[f] !== undefined) {
            wrong.push(`${fam}/${id}: the backup has no ${f}, and the restored record holds the replaced copy's `
              + `${asStored(f, after[f])}`);
          }
          if (carried && asStored(f, after[f]) !== asStored(f, BACKUP[f])) {
            wrong.push(`${fam}/${id}: the backup's ${f} ${asStored(f, BACKUP[f])} was restored as ${asStored(f, after[f])}`);
          }
        }
      }
    }
    assert.deepEqual(wrong, [], 'a restore carried record-tier local fields the backup did not hold, from the copy it '
      + 'replaced: a retention stamp that is not the backup\'s decides when the restored record is deleted');
  });
});
