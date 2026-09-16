/**
 * Integration tests: Space rename
 *
 * Covers:
 *  - Rename a solo (non-networked) space — collections, files, config updated
 *  - Data survives rename — memories queryable under new ID
 *  - Files survive rename — accessible under new path
 *  - Rename updates network references (spaces[] and spaceMap)
 *  - Rename updates token scopes
 *  - Built-in space rename rejected
 *  - Rename to existing ID rejected (409)
 *  - Invalid new ID rejected (400)
 *  - Rename non-existent space (404)
 *
 * Run: node --test testing/integration/space-rename.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, delWithBody } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const createdSpaceIds = [];
const RUN_ID = Date.now();

describe('Space rename', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('Rename a solo space — returns 200 with updated space', async () => {
    const oldId = `rename-src-${RUN_ID}`;
    const newId = `rename-dst-${RUN_ID}`;
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Rename Source' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    createdSpaceIds.push(newId); // track the renamed one (old is gone)

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, `Expected 200, got ${renameR.status}: ${JSON.stringify(renameR.body)}`);
    assert.equal(renameR.body.space?.id, newId);
  });

  it('Data survives rename — memories queryable under new ID', async () => {
    const oldId = `data-rename-${RUN_ID}`;
    const newId = `data-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Data Rename' });

    // Write a memory
    const writeR = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/facts`, {
      fact: 'Rename survival test fact',
      tags: ['rename-test'],
    });
    assert.equal(writeR.status, 201);
    const memId = writeR.body._id;

    // Rename
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Old ID should 404
    const oldR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/facts`);
    assert.ok(oldR.status === 403 || oldR.status === 404, `Old space should be gone, got ${oldR.status}`);

    // New ID should have the memory
    const newR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/facts`);
    assert.equal(newR.status, 200);
    const found = newR.body.facts?.some(m => m._id === memId);
    assert.ok(found, 'Memory should exist under the renamed space');
  });

  it('Data survives rename — entities and edges are still LISTED under the new ID', async () => {
    // Regression: renaming a space renamed its collections but left the `spaceId` field
    // inside every document pointing at the OLD id. `listEntities` / `listEdges` filter on
    // that field, so the data silently vanished from the UI — while the counts (which read
    // the collection) still showed it. `listFacts` does NOT filter on spaceId, which is
    // exactly why the memory-only test above kept passing and this went unnoticed.
    const oldId = `ee-rename-${RUN_ID}`;
    const newId = `ee-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Entity Edge Rename' });

    const aR = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/entities`, { name: 'Ada', type: 'person' });
    const bR = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/entities`, { name: 'Grace', type: 'person' });
    assert.equal(aR.status, 201, JSON.stringify(aR.body));
    assert.equal(bR.status, 201, JSON.stringify(bR.body));

    const edgeR = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/edges`, {
      from: aR.body._id, to: bR.body._id, label: 'knows',
    });
    assert.equal(edgeR.status, 201, JSON.stringify(edgeR.body));

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    const entR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/entities`);
    assert.equal(entR.status, 200);
    assert.equal(
      entR.body.entities?.length, 2,
      'entities must still be LISTED after a rename (they were present but invisible: the ' +
      'spaceId field inside each document still pointed at the old space id)',
    );

    const edgR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/edges`);
    assert.equal(edgR.status, 200);
    assert.equal(edgR.body.edges?.length, 1, 'edges must still be LISTED after a rename');

    // The stale field also broke entity lookup BY NAME (the same spaceId filter), which is
    // what `saveFact` uses to link to an existing entity rather than creating a duplicate.
    const byName = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/entities?name=Ada`);
    assert.equal(byName.status, 200);
    assert.equal(
      byName.body.entities?.length, 1,
      'entity lookup by name must still work after a rename — otherwise `saveFact` stops ' +
      'matching existing entities and starts creating duplicates',
    );
  });

  it('Data survives rename — chrono entries are still LISTED under the new ID', async () => {
    // `listChrono` filters on the spaceId FIELD (brain/chrono.ts), exactly like entities and
    // edges — so a rename hid chrono entries too. Nothing covered it: the rename suite only
    // ever created memories, which are the ONE read path that does not filter on spaceId.
    const oldId = `chrono-rename-${RUN_ID}`;
    const newId = `chrono-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Chrono Rename' });

    const cR = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/chrono`, {
      title: 'Launch', type: 'milestone', startsAt: new Date().toISOString(),
    });
    assert.equal(cR.status, 201, JSON.stringify(cR.body));

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    const listR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/chrono`);
    assert.equal(listR.status, 200);
    assert.equal(
      listR.body.chrono?.length, 1,
      'chrono entries must still be LISTED after a rename (listChrono filters on the spaceId field)',
    );
  });

  it('Rename carries the seq counter forward — new writes still sync to peers', async () => {
    // The seq counter lives in the GLOBAL `ythril_counters` collection keyed by `_id: spaceId`,
    // so the prefix-based collection rename missed it and nextSeq() restarted at 1 — while the
    // rename deliberately carries the OLD, high sync watermarks over to the new id. Every new
    // write then got a seq BELOW the watermark and was never pushed: the space kept working
    // locally while silently never syncing again.
    const oldId = `seq-rename-${RUN_ID}`;
    const newId = `seq-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Seq Rename' });

    // Burn some sequence numbers so the counter is unambiguously > 1.
    for (let i = 0; i < 3; i++) {
      const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/facts`, { fact: `seq burn ${i}` });
      assert.equal(w.status, 201, JSON.stringify(w.body));
    }
    const beforeR = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${oldId}/facts`);
    const seqBefore = Math.max(...beforeR.body.facts.map(m => m.seq));
    assert.ok(seqBefore >= 3, `expected a burned-in seq, got ${seqBefore}`);

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // The next write must continue the sequence, NOT restart at 1.
    const afterW = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${newId}/facts`, { fact: 'after rename' });
    assert.equal(afterW.status, 201, JSON.stringify(afterW.body));
    assert.ok(
      afterW.body.seq > seqBefore,
      `seq must keep climbing across a rename (was ${seqBefore}, got ${afterW.body.seq}) — a reset to 1 ` +
      'silently strands every later write below the sync watermark',
    );
  });

  it('Files survive rename — accessible under new path', async () => {
    const oldId = `file-rename-${RUN_ID}`;
    const newId = `file-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'File Rename' });

    // Write a file via query-param API
    const writeR = await post(INSTANCES.a, tokenA, `/api/files/${oldId}?path=${encodeURIComponent('test-file.txt')}`, {
      content: 'file rename test content',
    });
    assert.ok([200, 201, 202].includes(writeR.status), `File write: ${JSON.stringify(writeR.body)}`);

    // Rename
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // File should be accessible under new space
    const fileR = await get(INSTANCES.a, tokenA, `/api/files/${newId}?path=${encodeURIComponent('test-file.txt')}`);
    assert.equal(fileR.status, 200, `File should be readable under new space, got ${fileR.status}`);
  });

  it('Rename updates network spaces[] and adds spaceMap entry', async () => {
    const oldId = `net-rename-${RUN_ID}`;
    const newId = `net-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Net Rename' });

    // Create a network with this space
    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Rename Test Net ${RUN_ID}`,
      type: 'closed',
      spaces: [oldId],
      votingDeadlineHours: 24,
    });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    const networkId = netR.body.id ?? netR.body.network?.id;

    // Rename space
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Network should now reference newId in spaces[]
    const netListR = await get(INSTANCES.a, tokenA, '/api/networks');
    assert.equal(netListR.status, 200);
    const net = netListR.body.networks?.find(n => n.id === networkId);
    assert.ok(net, 'Network should still exist');
    assert.ok(net.spaces.includes(newId), `Network spaces should include '${newId}', got: ${JSON.stringify(net.spaces)}`);
    assert.ok(!net.spaces.includes(oldId), `Network spaces should NOT include '${oldId}'`);

    // spaceMap should map oldId → newId (so peers still referencing the old ID can resolve)
    assert.ok(net.spaceMap, 'Network should have spaceMap after rename');
    assert.equal(net.spaceMap[oldId], newId, `spaceMap should map '${oldId}' → '${newId}'`);

    // Cleanup network
    const delNet = await delWithBody(INSTANCES.a, tokenA, `/api/networks/${networkId}`, { confirm: true }).catch(() => {});
  });

  it('Rename updates token scopes', async () => {
    const oldId = `token-rename-${RUN_ID}`;
    const newId = `token-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Token Rename' });

    // Create a space-scoped token
    const tokenR = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `Scoped token ${RUN_ID}`,
      rights: legacyRights({ spaces: [oldId] })
    });
    assert.equal(tokenR.status, 201, JSON.stringify(tokenR.body));
    const tokenId = tokenR.body.token?.id;

    // Rename space
    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    // Token should now reference the new space ID
    const tokensR = await get(INSTANCES.a, tokenA, '/api/tokens');
    assert.equal(tokensR.status, 200);
    const tok = tokensR.body.tokens?.find(t => t.id === tokenId);
    assert.ok(tok, 'Token should still exist');
    assert.ok(tok.spaces?.includes(newId), `Token spaces should include '${newId}'`);
    assert.ok(!tok.spaces?.includes(oldId), `Token spaces should NOT include '${oldId}'`);

    // The RIGHTS MATRIX, which is the half that actually governs access — and the half this test used to
    // miss. It asserted only on `spaces`, the pre-3.0 allowlist, which the rename did maintain. So it
    // stayed green while every matrix-scoped token silently lost the renamed space: the `perSpace` row
    // stayed under an id that no longer named anything.
    //
    // Every token minted today carries a matrix, including this one — `createToken` derives it from the
    // `spaces` sent above — so the case this test covered was the case nobody has.
    assert.ok(tok.rights?.perSpace, 'a token minted today carries a rights matrix');
    assert.ok(tok.rights.perSpace[newId],
      `Token rights should hold a row for '${newId}', got: ${JSON.stringify(Object.keys(tok.rights.perSpace))}`);
    assert.equal(tok.rights.perSpace[oldId], undefined,
      `Token rights must not keep a row under the dead id '${oldId}'`);
  });

  it('and the renamed space is still REACHABLE with that token', async () => {
    // The assertion that cannot pass on a technicality: read with the scoped token itself. Checking the
    // stored shape proves the re-key ran; this proves it produced access — which is what was missing, as a
    // 403 that read as though the rights had never been granted.
    const oldId = `reach-rename-${RUN_ID}`;
    const newId = `reach-renamed-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: oldId, label: 'Reach Rename' });

    const tokenR = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `Reach token ${RUN_ID}`,
      rights: legacyRights({ spaces: [oldId] })
    });
    assert.equal(tokenR.status, 201, JSON.stringify(tokenR.body));
    const scoped = tokenR.body.plaintext;

    const before = await get(INSTANCES.a, scoped, `/api/brain/spaces/${oldId}/entities`);
    assert.equal(before.status, 200,
      `scoped token should reach its space before the rename: ${JSON.stringify(before.body)}`);

    const renameR = await patch(INSTANCES.a, tokenA, `/api/spaces/${oldId}/rename`, { newId });
    assert.equal(renameR.status, 200, JSON.stringify(renameR.body));
    createdSpaceIds.push(newId);

    const after = await get(INSTANCES.a, scoped, `/api/brain/spaces/${newId}/entities`);
    assert.equal(after.status, 200,
      `scoped token must still reach the space after it is renamed: ${JSON.stringify(after.body)}`);
  });

  it('Rename built-in general space is rejected', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/spaces/general/rename', { newId: 'new-general' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('Rename to existing space ID is rejected (409)', async () => {
    const srcId = `conflict-src-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: srcId, label: 'Conflict Src' });
    createdSpaceIds.push(srcId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${srcId}/rename`, { newId: 'general' });
    assert.equal(r.status, 409, `Expected 409, got ${r.status}`);
  });

  it('Rename with invalid new ID is rejected (400)', async () => {
    const srcId = `invalid-rename-${RUN_ID}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: srcId, label: 'Invalid Rename' });
    createdSpaceIds.push(srcId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${srcId}/rename`, { newId: 'UPPER_CASE!' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('Rename non-existent space returns 404', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/spaces/does-not-exist/rename', { newId: 'whatever' });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}`);
  });
});
