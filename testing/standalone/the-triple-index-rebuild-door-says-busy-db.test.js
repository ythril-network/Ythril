/**
 * The admin door of the triple index rebuild answers `started` only for a rebuild it started: when another instance holds the build row,
 * it answers `409 rebuild_busy` (bundle-273, Q-764, review finding F11).
 *
 * ## The rule
 *
 * The door claims the build row before it answers. A claim another build holds is refused, with a code of its own on both doors (REST
 * and the tool `space_rdf_rebuild`); before, the door answered `started` at once, the background rebuild then met the held row, ended
 * `busy`, and nothing said so: the caller polled a rebuild that was never running. One of this process (`running`) is still joined.
 *
 * ## Seen red
 *
 * On 42c51f330: the REST door answers 200 `started` over a held build row.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-rebuild-door-says-busy-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { elapse } from '../_shared/sleep.mjs';
import { waitForReading } from '../_shared/wait-for.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixd-busy';
let d, admin;
const buildOf = async () => (await d.col(`${S}_rdf_state`).findOne({ _id: 'state' }))?.buildId;

/** `POST /api/brain/spaces/:id/rdf-index/rebuild`: status and body. */
async function restRebuild() {
  const r = await fetch(`${d.server.url}/api/brain/spaces/${S}/rdf-index/rebuild`, {
    method: 'POST', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${admin.key}` },
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body, text };
}

describe('the triple index rebuild door says busy', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixd-busy', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixd-busy-admin', { [S]: d.row({ knowledge: 'admin' }) });
    await landAll(d, S, Array.from({ length: 10 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('a build row another instance holds is refused 409 rebuild_busy on both doors, and nothing is started', async () => {
    const was = await buildOf();
    await d.col(`${S}_rdf_state`).updateOne({ _id: 'build' },
      { $set: { buildId: 'a'.repeat(16), until: Date.now() + 60_000, startedAt: Date.now() } }, { upsert: true });
    try {
      const rest = await restRebuild();
      assert.equal(rest.status, 409, `REST refuses: ${rest.text}`);
      assert.equal(rest.body?.code, 'rebuild_busy', rest.text);
      const mcp = await d.toolCall(admin.key, 'space_rdf_rebuild', { space: S });
      assert.equal(mcp.isError, true, `the tool refuses: ${mcp.text}`);
      assert.match(mcp.text, /rebuild_busy/);
      await elapse(300, 'absence window: a rebuild the refused calls had started would have swapped in by now');
      assert.equal(await buildOf(), was, 'the index was not rebuilt');
    } finally {
      await d.col(`${S}_rdf_state`).updateOne({ _id: 'build' }, { $set: { until: 0 } });
    }
  });

  it('with the row free the door starts a rebuild', async () => {
    const was = await buildOf();
    const first = await restRebuild();
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body?.status, 'started');
    await waitForReading(async () => ({ now: await buildOf() }), (r) => r.now !== was, 20_000, 50, { what: 'the rebuild the door started to swap in' });
    await followUntilReady(d, S);
  });
});
