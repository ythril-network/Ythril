/**
 * A derived file description never overwrites one a person wrote — decided by the database, in one write.
 *
 * ## The defect
 *
 * The media worker read the stored description, computed `operatorWrote` from it, and then wrote its derived text on that
 * decision. The intent was right and documented — *"Only the description itself is theirs to keep"* — but a
 * read-modify-write cannot win the race it exists to win: an operator PATCH landing between the read and the write was
 * silently replaced. No field missing, no status wrong, the description simply somebody else's.
 *
 * Same shape as the 2.5.1 embedding defect, which computed a vector from the record *as the write had read it*.
 *
 * ## Why the window is held open ARTIFICIALLY, and why that is the honest test
 *
 * On an idle machine the worker wins the race comfortably; I could not reproduce the loss locally in either order. The
 * only evidence of the symptom is a CI run under load. So a test that races and hopes to lose would pass on the broken
 * code most of the time — which is worse than no test.
 *
 * Instead these assertions call the write path directly with the interleaving forced: set an operator description, THEN
 * ask for the derived write, and require it to decline. That is exactly what the conditional filter guarantees and it is
 * deterministic.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/derived-description-loses-to-the-operator-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const FILE = 'docs/report.md';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-derived-desc-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, meta, derived;

const files = () => mongo.col(`${SPACE}_files`);
const stored = async () => await files().findOne({ _id: FILE });

describe('a derived description never beats the operator (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('deriveddesc');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
    // `setDerivedDescriptionIfUnset` moved to `files/derived-fields.ts` in bundle-89, with the other writers of what a
    // file's bytes produced. The behaviour every case here pins is unchanged — the conditions are still in the filter.
    derived = await import('../../server/dist/files/derived-fields.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
  });

  it('writes the derived description when the field is ABSENT', async () => {
    // The ordinary case, and the reason the guard cannot simply refuse: a file nobody has described should get one.
    // `upsertFileMeta` CREATES; `updateFileMeta` only updates an existing record and silently does nothing without
    // one. And its third parameter is `sizeBytes`, not the opts bag — passing the opts third made it the SIZE and
    // dropped every option without complaint. Both mistakes were mine, in sequence, and each produced a test that
    // failed for a reason unrelated to the code under test.
    await meta.upsertFileMeta(SPACE, FILE, 64, { tags: ['rma'] });
    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived summary', 'generated'), true);
    const d = await stored();
    assert.equal(d.description, 'Derived summary');
    assert.equal(d.descriptionSource, 'generated');
  });

  it('DECLINES when the operator already wrote one — the defect', async () => {
    await meta.upsertFileMeta(SPACE, FILE, 64, { description: 'MINE' });
    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived summary', 'generated'), false,
      'the derived write must report that it did nothing');
    assert.equal((await stored()).description, 'MINE',
      'an operator description was overwritten by derived text — the exact loss this exists to prevent');
  });

  it('declines even when the operator wrote AFTER the caller decided to write', async () => {
    // The interleaving, forced. This is the race: the worker resolves its intent, the operator writes, and only then does
    // the worker's write land. The condition lives in the filter, so the late write loses rather than the operator.
    await meta.upsertFileMeta(SPACE, FILE, 64, { tags: ['rma'] });
    const intent = { description: 'Derived summary', source: 'generated' };   // decided while the field was empty

    await meta.updateFileMeta(SPACE, FILE, { description: 'MINE, written in the window' });

    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, FILE, intent.description, intent.source), false);
    assert.equal((await stored()).description, 'MINE, written in the window');
  });

  it('treats a WHITESPACE-ONLY description as absent, matching the guard it replaces', async () => {
    // The old check was `!!parentMeta?.description?.trim()`, so "   " counted as unwritten. Preserved deliberately: a
    // fix that quietly changed which values count as "described" would be a second behaviour change smuggled in.
    await meta.upsertFileMeta(SPACE, FILE, 64, { description: '   ' });
    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived summary', 'extracted'), true);
    assert.equal((await stored()).description, 'Derived summary');
  });

  it('UNSETS descriptionSource when the derived write has no provenance', async () => {
    // `updateFileMeta` unsets it in that case, so a description with unknown provenance must not inherit the previous
    // one's label. Ported rather than defaulted — mislabelling where text came from is worse than the race.
    await meta.upsertFileMeta(SPACE, FILE, 64, { description: 'old' });
    await files().updateOne({ _id: FILE }, { $set: { descriptionSource: 'generated' } });
    await files().updateOne({ _id: FILE }, { $set: { description: '' } });

    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived, source unknown'), true);
    const d = await stored();
    assert.equal(d.description, 'Derived, source unknown');
    assert.ok(!('descriptionSource' in d), `descriptionSource must be unset, got ${JSON.stringify(d.descriptionSource)}`);
  });

  it('does not create a record for a file that has no meta at all', async () => {
    // The filter matches on `_id`, so a missing record means no match. Creating one here would invent a file-meta record
    // for a path the operator may have deleted mid-conversion.
    assert.equal(await derived.setDerivedDescriptionIfUnset(SPACE, 'docs/never-existed.md', 'Derived', 'generated'), false);
    assert.equal(await files().countDocuments({}), 0);
  });
});
