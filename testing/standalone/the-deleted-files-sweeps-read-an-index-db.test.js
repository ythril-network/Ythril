/**
 * The two sweep queries that look for deleted files' records read an index, not the whole files collection
 * (bundle-89 pre-ship pass, performance lens).
 *
 * ## What it guards
 *
 * Every TTL cycle, for every space, two queries ask the files collection for records flagged `deletedAt`: the one-off
 * repair that strips what the bytes made from rows an earlier release flagged (`stripFlaggedRowsOnce`,
 * `files/derived-fields.ts`), and the purge of deleted files' audit records once the space's file window has passed
 * (`flaggedPage`, `brain/ttl-sweep.ts`). Neither had an index to read, so both scanned every file record — chunks,
 * captions and faces included — on every space, every five minutes, to find usually nothing. The repair's own comment
 * called that "one bounded read".
 *
 * The sweep's indexes are ensured by `ensureTtlIndex` (`brain/ttl.ts`), which already gives chrono's content-redaction
 * query its own sparse index for exactly this reason; `deletedAt` is the files twin.
 *
 * ## How
 *
 * Seed many live file rows and a few flagged ones, ensure the sweep indexes, and ask the planner for both queries'
 * winning plan and how many documents each examined. The assertion is on the plan reading the index AND on the work
 * being the flagged rows, not the collection — a plan can name an index and still fetch everything.
 *
 * Run: node --test testing/standalone/the-deleted-files-sweeps-read-an-index-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'sweepix';
const LIVE = 400;
const FLAGGED = 3;

let mongo;
const files = () => mongo.col(`${SPACE}_files`);

/** The repair's question: a flagged row still holding something its bytes made (fixture literal, on purpose). */
const STRIP_QUERY = { deletedAt: { $exists: true }, $or: [{ embedding: { $exists: true } }, { sha256: { $exists: true } }] };
/** The purge's question: a flagged row whose deletion is older than the window. */
const PURGE_QUERY = { deletedAt: { $exists: true, $lte: '2099-01-01T00:00:00.000Z' } };

/** Index names anywhere in a winning plan tree. */
function indexesIn(stage, out = []) {
  if (!stage || typeof stage !== 'object') return out;
  if (stage.indexName) out.push(stage.indexName);
  for (const k of ['inputStage', 'queryPlan']) indexesIn(stage[k], out);
  for (const s of stage.inputStages ?? []) indexesIn(s, out);
  return out;
}

describe('the deleted files\' sweep queries read an index (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('sweepix');
    const docs = [];
    for (let i = 0; i < LIVE; i++) docs.push({ _id: `live/${i}.md`, path: `live/${i}.md`, sha256: 'a'.repeat(64), seq: i + 1 });
    for (let i = 0; i < FLAGGED; i++) {
      docs.push({ _id: `gone/${i}.md`, path: `gone/${i}.md`, sha256: 'b'.repeat(64), seq: LIVE + i + 1, deletedAt: '2026-01-01T00:00:00.000Z' });
    }
    await files().insertMany(docs);
    const { ensureTtlIndex } = await import('../../server/dist/brain/ttl.js');
    await ensureTtlIndex(SPACE);
  });
  after(async () => { await closeTestMongo(); });

  for (const [name, query] of [['the flagged-row repair', STRIP_QUERY], ['the deleted-file record purge', PURGE_QUERY]]) {
    it(`${name} reads the deletedAt index and examines only the flagged rows`, async () => {
      const ex = await files().find(query).explain('executionStats');
      const used = indexesIn(ex.queryPlanner.winningPlan);
      const examined = ex.executionStats.totalDocsExamined;
      assert.ok(used.some(n => /deletedAt/.test(n)),
        `${name} planned ${JSON.stringify(used)} — no deletedAt index, so it scans every file record every cycle`);
      assert.ok(examined <= FLAGGED,
        `${name} examined ${examined} documents for ${FLAGGED} flagged rows among ${LIVE + FLAGGED}: it read the collection`);
    });
  }
});
