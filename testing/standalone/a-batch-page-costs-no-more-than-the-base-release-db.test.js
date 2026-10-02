/**
 * A `batch-upsert` page costs no more database round trips than it did in the base release (5.6.1, `d62573ed`) —
 * `Q-218` round R, item R4.
 *
 * ## The rule
 *
 * The patch reroutes every pushed document through the arrival writer. Called once PER DOCUMENT, the writer re-reads
 * the stored copy the door has just read (`batchUpsertBySeq` -> `readStoredById`) and moves the counter (`bumpSeq`)
 * — so a page of N documents costs N extra reads and N extra counter writes, and every one of those writes lands on
 * the SAME counter document (`ythril_counters/<space>`), which serialises a busy space's pushes on one row. A patch
 * release must not make the hottest door of a sync network slower than the release it patches.
 *
 * So, per page and per family, for a page of new records and a page of updates over stored copies:
 *
 *  - **stored-copy reads** (`find` on the family's collection) are no more than 5.6.1 made for the same page;
 *  - **counter writes** (`update` on `ythril_counters`) are no more than 5.6.1 made — one per page.
 *
 * ## Why the base numbers are literals
 *
 * They are a record of what 5.6.1 did, measured by running THIS file's counting against `d62573ed` (with
 * `_push-door.mjs` copied in for that run). Derived from the code under test they would compare it with itself.
 * They are held per document (reads) and per page (counter writes), so a different N needs no new measurement.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-batch-page-costs-no-more-than-the-base-release-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushcost';
const N = 20;
/** The families a page is measured for: every family with a document builder that the batch door carries. */
const MEASURED = Object.entries(FAMILIES).map(([key, f]) => ({ key, ...f }));
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' };

/**
 * What 5.6.1 (`d62573ed`) did for a page of N documents of one family, measured by this file (2026-10-02, N = 20,
 * inserts and updates alike): stored-copy reads PER DOCUMENT — one `findOne` per record family, two per file
 * (the door's seq read and `ingestFileMeta`'s own) — and counter writes PER PAGE. Literal on purpose — see the
 * docblock.
 *
 * The counter bound is ONE per page for every family. 5.6.1 measured one for the four record families and NONE for
 * links and file metadata, because its page bump covered only the first four — the defect `Q-198` fixed by moving
 * the counter past every family's seqs. Bounding those two at zero would forbid the fix; one per page is 5.6.1's
 * cost for a page, which is the rule.
 */
const BASE_READS_PER_DOC = { facts: 1, entities: 1, edges: 1, chrono: 1, links: 1, filemeta: 2 };
const BASE_COUNTER_WRITES_PER_PAGE = 1;

let door;

/** Every command the page cost, sorted into the two this rule bounds. */
async function costOf(body, coll) {
  const commands = await door.commandsDuring(async () => {
    const r = await door.push('/batch-upsert', body, { spaceId: S });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    await door.settled();
  });
  return {
    reads: commands.filter(c => c === `find ${S}_${coll}`).length,
    counterWrites: commands.filter(c => /^(update|findAndModify) ythril_counters$/.test(c)).length,
    commands,
  };
}

describe('a batch-upsert page costs no more round trips than the base release', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushcost', spaces: [{ id: S, label: 'Cost', folders: [], meta: {} }],
      monitorCommands: true });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('every family the batch door carries is measured', () => {
    assert.ok(MEASURED.length >= 6, `only ${MEASURED.length} families measured: ${MEASURED.map(f => f.key)}`);
  });

  for (const fam of MEASURED) {
    for (const kind of ['insert', 'update']) {
      it(`${fam.key}, a page of ${N} ${kind === 'insert' ? 'new records' : 'updates over stored copies'}: `
        + 'no more stored-copy reads and counter writes than 5.6.1', async () => {
        const docs = (seq0) => Array.from({ length: N }, (_, i) => build[KIND[fam.key]](S, `${fam.key}-${i}`, seq0 + i,
          fam.key === 'edges' ? { from: `a-${i}`, to: `b-${i}` } : fam.key === 'links' ? { from: `a-${i}`, to: `b-${i}` } : {}));
        if (kind === 'update') await door.coll(S, fam.coll).insertMany(docs(100));
        const cost = await costOf({ [fam.key]: docs(1000) }, fam.coll);
        assert.ok(fam.key in BASE_READS_PER_DOC, `no 5.6.1 measurement for ${fam.key} — measure it at d62573ed`);
        const base = { reads: BASE_READS_PER_DOC[fam.key] * N, counterWrites: BASE_COUNTER_WRITES_PER_PAGE };
        assert.ok(cost.reads <= base.reads && cost.counterWrites <= base.counterWrites,
          `${fam.key} ${kind}: a page of ${N} cost ${cost.reads} stored-copy read(s) of ${S}_${fam.coll} and `
          + `${cost.counterWrites} counter write(s); 5.6.1 cost ${base.reads} and ${base.counterWrites}. Each extra counter `
          + 'write lands on the one counter document of the space. Commands: '
          + JSON.stringify([...new Set(cost.commands)].map(c => `${c} x${cost.commands.filter(x => x === c).length}`)));
      });
    }
  }
});
