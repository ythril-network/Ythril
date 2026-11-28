/**
 * While a space act holds a space (an RDF import above all, which holds it for its whole length), the triple index upkeep starts no rebuild
 * of it and says once that the rebuild waits; the first tick after the act ends rebuilds it (bundle-385, Q-985).
 *
 * ## The rule
 *
 * Two drives of bundle-384 saw "Triple index of space 'bsbm': rebuilding (stale)" once a minute, 39 times, for the whole of a 56-minute RDF
 * import, and no outcome after any of them. The cause is a log with no work: an RDF import is a space act (`config/types-space-acts.ts`
 * `rdf-import`), a rebuild refuses a held space at its first line (`rebuild.ts`, outcome `held`, said nowhere), the upkeep logged its line
 * before the launch, and the backoff counts no `held`, so every tick did the same. Measured here, over three ticks under a standing act:
 * no rebuild started (the rebuild counter gains nothing for the space's reason), no "rebuilding" line, exactly one "waits" line. Then, with
 * the act gone, one tick rebuilds the index, logs "rebuilt", and the index states exactly the records.
 *
 * ## Seen red
 *
 * On 9899c4029: "no rebuild was started while the act held the space: 3 !== 0"; each tick under the act counted a rebuild `{stale, held}`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-upkeep-waits-for-an-act-holding-its-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../_shared/wait-for.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, bendState, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const S = 'tixw-held';
const ACT = { id: 'q985-standing-rdf-import', localId: S, kind: 'rdf-import', state: 'running', spoolId: 'q985-spool', rounds: [], requestedAt: '2026-11-28T00:00:00.000Z' };
let d, metrics;

/** The rebuilds the counter holds for reason `stale`, of one outcome or of every outcome. */
async function staleRebuilds(outcome) {
  const values = (await metrics.rdfIndexRebuildsTotal.get()).values.filter(v => v.labels.reason === 'stale' && (outcome === undefined || v.labels.outcome === outcome));
  return values.reduce((n, v) => n + v.value, 0);
}
const about = (lines, words) => lines.filter(l => l.includes(`Triple index of space '${S}'`) && l.includes(words));

/** Wait until no rebuild of S runs (in this process or by a build row). */
async function idle() {
  const { tripleIndexStatusOf } = await rebuildModule();
  await waitFor(async () => !(await tripleIndexStatusOf(S)).rebuilding, 30_000, 50, undefined, { what: 'the rebuild a tick started to end' });
}

describe('the triple index upkeep waits for an act holding its space', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b385-tixw-held', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 8 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    metrics = await import('../../server/dist/metrics/rdf-index-metrics.js');
    const { requestTripleIndexRebuild } = await rebuildModule();
    assert.equal((await requestTripleIndexRebuild(S)).outcome, 'built', 'the index is built before the act');
  });
  after(async () => { await d?.close(); });

  it('starts no rebuild under the act, says so once, and rebuilds the tick after the act ends', async () => {
    const { upkeepTripleIndexes } = await verifyModule();
    const { getConfig } = await import('../../server/dist/config/loader.js');
    // The state an import leaves once the follower met its writes: the index is stale, and the act still stands.
    await bendState(d, S, { status: 'stale' });
    const cfg = getConfig();
    const kept = cfg.pendingSpaceActs;
    cfg.pendingSpaceActs = [...(kept ?? []), ACT];
    const before = await staleRebuilds();
    let held;
    try {
      held = await logLinesDuring(async () => {
        for (let tick = 0; tick < 3; tick++) { await upkeepTripleIndexes(); await idle(); }
      });
    } finally { cfg.pendingSpaceActs = kept; }
    assert.equal(await staleRebuilds() - before, 0, 'no rebuild was started while the act held the space');
    assert.deepEqual(about(held.lines, 'rebuilding'), [], 'no tick logged a rebuild it could not start');
    assert.equal(about(held.lines, 'waits').length, 1, `the wait is said once over three ticks: ${JSON.stringify(about(held.lines, 'Triple index'))}`);

    const builtBefore = await staleRebuilds('built');
    const freed = await logLinesDuring(async () => { await upkeepTripleIndexes(); await idle(); });
    assert.equal(await staleRebuilds('built'), builtBefore + 1, 'the tick after the act rebuilt the index');
    assert.equal(about(freed.lines, 'rebuilt').length, 1, `the rebuild after the act says rebuilt: ${JSON.stringify(about(freed.lines, 'Triple index'))}`);
    await assertIndexEqualsRecords(assert, d, S);
  });
});
