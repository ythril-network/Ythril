/**
 * An import keeps counts, never the documents, while it runs: what it recorded is a tally, and its totals are summed in one place (bundle-40
 * pre-ship P2 and A1, `Q-267`).
 *
 * ## The rules this file holds
 *
 *  1. **What an import recorded is a tally of counts, bounded whatever the body holds.** The accumulator held every document that broke the
 *     schema (`Map<family, Map<id, rows>>`) for the whole import, up to `importMaxDocuments` (5 000 000), only for `sayRecorded` to count them
 *     at the end. The tally keeps the documents per family and the documents per field name, at most `TALLY_NAMES_HELD` names.
 *  2. **The tally says what the documents said:** the summary of a tally is the summary of the same documents held whole (`summarise`).
 *  3. **One sum of an import's totals** (`importTotals`), which the door's audit row and the act's completion row both read: they were summed
 *     twice, in `api/admin-space-transfer.ts` and `spaces/import-act.ts`.
 *
 * ## Seen red
 *
 * On 505b5790c the accumulator's `recorded` is a `Map` of documents, and `tallyRecorded`, `newRecordedTally` and `importTotals` do not exist.
 *
 * Run: `node --test testing/standalone/an-import-keeps-counts-not-documents-while-it-runs.test.js` (a prior `npm run build:server`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let recording, importer;

describe('an import keeps counts, not documents, while it runs', () => {
  before(async () => {
    recording = await import('../../server/dist/sync/arrival-recording.js');
    // The importer core: `api/admin-import.js` on the base, `sync/space-import.js` after A2.
    importer = await import('../../server/dist/sync/space-import.js').catch(() => import('../../server/dist/api/admin-import.js'));
  });

  it('the accumulator records a tally, and the tally stays bounded over many documents that break the schema', () => {
    assert.equal(typeof importer.newImportAccumulator, 'function', 'fixture check: the importer has no accumulator');
    const acc = importer.newImportAccumulator('s');
    assert.equal(typeof recording.tallyRecorded, 'function', 'there is no tally to record into: the accumulator keeps every document');
    assert.ok(acc.recorded.families instanceof Map && acc.recorded.names instanceof Map,
      `the accumulator's recorded is not a tally of counts: ${Object.prototype.toString.call(acc.recorded)} of ${acc.recorded?.size} entries`);
    const DOCS = 200_000;
    const docs = function* () {
      for (let i = 0; i < DOCS; i++) yield [{ field: 'properties.colour', reason: 'r' }, { field: `properties.k${i}`, reason: 'r' }];
    };
    // In pages, as the import merges them.
    const page = [];
    for (const rows of docs()) { page.push(rows); if (page.length === 500) { recording.tallyRecorded(acc.recorded, 'entities', page); page.length = 0; } }
    recording.tallyRecorded(acc.recorded, 'entities', page);
    assert.equal(acc.recorded.families.get('entities'), DOCS, 'the tally lost documents');
    assert.equal(acc.recorded.families.size, 1);
    assert.ok(acc.recorded.names.size <= recording.TALLY_NAMES_HELD, `the tally holds ${acc.recorded.names.size} names, over its bound of ${recording.TALLY_NAMES_HELD}`);
    assert.equal(acc.recorded.names.get('properties.colour'), DOCS, 'a name every document carried is not counted for each');
  });

  it('the summary of a tally is the summary of the documents held whole', () => {
    const families = new Map([
      ['facts', new Map([['a', [{ field: 'x', reason: 'r' }, { field: 'x', reason: 'r2' }]], ['b', [{ field: 'y', reason: 'r' }]]])],
      ['entities', new Map([['c', [{ field: 'x', reason: 'r' }, { field: 'z', reason: 'r' }]]])],
    ]);
    const tally = recording.newRecordedTally();
    for (const [family, docs] of families) recording.tallyRecorded(tally, family, docs.values());
    const said = recording.sayRecordedTally({ spaceId: 's', source: 'import', peer: 'import', tally });
    assert.deepEqual(said, recording.summarise(families));
    assert.deepEqual(said, { records: 3, top: [{ name: 'x', count: 2 }, { name: 'y', count: 1 }, { name: 'z', count: 1 }] });
  });

  it('one sum of an import\'s totals over every family', () => {
    assert.equal(typeof importer.importTotals, 'function', 'the totals are summed where they are used, twice');
    const result = { spaceId: 's', results: {
      facts: { inserted: 3, updated: 1, errors: 2, deletedOnRestoreTotal: 1, dueTotal: 4 },
      entities: { inserted: 5, updated: 0, errors: 0 },
      files: { inserted: 0, updated: 2, errors: 1, dueTotal: 1 },
    } };
    assert.deepEqual(importer.importTotals(result), { inserted: 8, updated: 3, refused: 3, deletedOnRestore: 1, due: 5 });
  });
});
