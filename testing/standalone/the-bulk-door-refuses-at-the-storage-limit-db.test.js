/**
 * The bulk door refuses at the brain's hard storage limit, as the fact doors do, on REST and on MCP (bundle-270, tail find T9).
 *
 * ## What it holds
 *
 * `POST /api/brain/spaces/:spaceId/bulk` and MCP `save_bulk` wrote a whole batch with the brain's hard limit reached, while the fact doors and the
 * RDF import refuse: REST `507` with `storageExceeded`, the tool an error naming the limit. One function (`bulkStorageRefusal`, `brain/bulk.ts`)
 * decides it for both doors, before anything is written; below the limit the batch is written as before.
 *
 * Run: node --test testing/standalone/the-bulk-door-refuses-at-the-storage-limit-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'bulkquota';

describe('the bulk door refuses at the brain\'s hard limit on both doors (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, writer;
  const batch = (n) => ({ entities: [{ name: `Person ${n}`, type: 'person' }] });
  const limit = (hard) => d.loader.mutateConfig(cfg => { cfg.storage = { brain: { softLimitGiB: hard, hardLimitGiB: hard } }; });

  before(async () => {
    d = await openRdfImportDoors({ suite: 'bulk_quota', spaces: [{ id: SPACE, meta: personMeta(SPACE, 'warn') }] });
    writer = await d.mint('bulk-quota-writer', { [SPACE]: d.row({ knowledge: 'write', schema: 'admin' }) });
  });
  after(async () => { await d?.close(); });

  it('with the hard limit reached REST answers 507 as the fact door does, the tool an error, and nothing is written', async () => {
    limit(0);
    try {
      const neighbour = await d.rest(writer.key, 'POST', `/api/brain/spaces/${SPACE}/facts`, { fact: 'a fact the limit refuses' });
      assert.equal(neighbour.status, 507, `the fact door refuses at the limit: ${neighbour.text?.slice(0, 200)}`);
      const rest = await d.rest(writer.key, 'POST', `/api/brain/spaces/${SPACE}/bulk`, batch(1));
      assert.equal(rest.status, 507, `REST: ${rest.text?.slice(0, 300)}`);
      assert.equal(rest.body?.storageExceeded, true);
      assert.equal(rest.body?.error, neighbour.body?.error, 'the same sentence as the fact door');
      const mcp = await d.toolCall(writer.key, 'save_bulk', { space: SPACE, ...batch(2) });
      assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
      assert.match(mcp.text, /hard limit/i);
      assert.deepEqual(await d.records(SPACE, 'entities'), [], 'nothing was written');
    } finally { d.loader.mutateConfig(cfg => { delete cfg.storage; }); }
  });

  it('below the limit the batch is written on both doors', async () => {
    const rest = await d.rest(writer.key, 'POST', `/api/brain/spaces/${SPACE}/bulk`, batch(3));
    assert.equal(rest.status, 207, rest.text?.slice(0, 300));
    const mcp = await d.toolCall(writer.key, 'save_bulk', { space: SPACE, ...batch(4) });
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.deepEqual((await d.records(SPACE, 'entities')).map(e => e.name).sort(), ['Person 3', 'Person 4']);
  });
});
