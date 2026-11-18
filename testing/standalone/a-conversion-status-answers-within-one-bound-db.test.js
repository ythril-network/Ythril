/**
 * The status of a conversion run answers within one bound, however many types are left to count, and says when the count of what is left was
 * not finished (`Q-746`, bundle-284 fix round after the lens sweep: S6).
 *
 * ## What it prevents
 *
 * `GET /api/spaces/:id/schema-convert` and `space_schema_conversion` counted what is left per unfinished type, one count after another, each with its
 * own two-second limit and no limit on the whole: a run whose types (the union across its restarts) number in the tens held a GET for minutes.
 *
 * ## What holds (the count is stubbed to be slow; the run document is a real one)
 *
 * - with six unfinished types and a count that takes its whole time limit every time, the answer comes within the one bound
 *   (`SCHEMA_CONVERT_LEFT_COUNT_MS`) plus a margin, never six of them;
 * - `left` is `null`: the count was not finished, and the answer says so rather than giving a partial number.
 *
 * Run: node --test testing/standalone/a-conversion-status-answers-within-one-bound-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const S = 'bounded';
const AT = '2026-01-01T00:00:00.000Z';
/** What the margin above the bound allows for: the run document's read and the event loop, never a second count's whole limit. */
const MARGIN_MS = 1_000;

describe('a conversion status answers within one bound (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284bounded', spaces: [S] });
    run = await door.runModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('six unfinished types and a count that takes its whole limit each time: one bound for the answer, and left is null', async () => {
    const types = ['a', 'b', 'c', 'd', 'e', 'f'].map(t => ({ kind: 'entity', type: `t${t}`, done: false }));
    await door.mongo.col(door.spaceCollection(S, 'schemaConvertRun')).insertOne({
      _id: 'run', toFp: door.fp(S), types, steps: [], splitDeclared: {}, stepsRefused: [], sources: [{ kind: 'act', at: AT }], owed: false,
      syncedFirst: { asked: 0, answered: 0 }, startedAt: AT, cursor: null, counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 },
      state: 'running', failures: 0, sweepLeaseAt: Date.now() + 3_600_000, generation: 1,
    });
    let counts = 0;
    // A count that uses the whole time it is given and then ends as the store ends one past its `maxTimeMS`.
    const countLeft = async (_collection, _filter, maxTimeMS) => {
      counts++;
      // waits-differently: the stub IS the slow store, so it must take the whole time it is given before it ends
      await new Promise(r => { setTimeout(r, maxTimeMS); });
      throw Object.assign(new Error('operation exceeded time limit'), { code: 50 });
    };
    const t0 = Date.now();
    const status = await run.schemaConvertStatus(S, { countLeft });
    const took = Date.now() - t0;
    assert.ok(counts >= 1, 'the stubbed count was not asked');
    assert.equal(status.left, null, `a count that did not finish was answered as a number: ${status.left}`);
    assert.ok(took < run.SCHEMA_CONVERT_LEFT_COUNT_MS + MARGIN_MS, `the answer took ${took} ms over ${types.length} types, past the one bound`);
  });
});
