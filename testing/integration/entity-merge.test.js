/**
 * Integration tests: Entity Merge
 *
 * Covers:
 *  - Basic merge: two entities merged, absorbed deleted, survivor updated
 *  - Edge relinking: absorbed edges point to survivor after merge
 *  - Memory relinking: entityIds reference survivor after merge
 *  - Self-merge rejection (400)
 *  - Duplicate edge auto-deletion: identical edges (except _id) after relink
 *  - Self-loop handling: A→A edge on absorbed becomes survivor→survivor
 *  - Merge is atomic: either fully succeeds or fully fails
 *
 * Requires a running instance at localhost:3200 with space "general".
 * Run: node --test testing/integration/entity-merge.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, patch, reqJson, readRecord } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const SPACE = 'general';
const A = INSTANCES.a;
function token() { return tokenA; }

before(() => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

// ── Helper: create entity ─────────────────────────────────────────────────

async function createEntity(name, type = 'thing', properties = {}, tags = []) {
  const r = await post(A, token(), `/api/brain/spaces/${SPACE}/entities`, { name, type, properties, tags });
  assert.equal(r.status, 201, `Entity create failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createEdge(from, to, label, props = {}) {
  const r = await post(A, token(), `/api/brain/spaces/${SPACE}/edges`, { from, to, label, properties: props });
  assert.equal(r.status, 201, `Edge create failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createMemory(fact, entityIds, tags = []) {
  const r = await post(A, token(), `/api/brain/spaces/${SPACE}/facts`, { fact, entityIds, tags });
  assert.equal(r.status, 201, `Memory create failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function merge(survivorId, absorbedId, resolutions = undefined) {
  const body = resolutions ? { resolutions } : {};
  return post(A, token(), `/api/brain/spaces/${SPACE}/entities/${survivorId}/merge/${absorbedId}`, body);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Entity Merge — integration', () => {
  it('basic merge: absorbed entity is deleted, survivor updated', async () => {
    const survivor = await createEntity('merge-survivor-1', 'person', { role: 'admin' }, ['tag-a']);
    const absorbed = await createEntity('merge-absorbed-1', 'person', { role: 'admin', extra: 'val' }, ['tag-b']);

    const r = await merge(survivor._id, absorbed._id);
    assert.equal(r.status, 200, `Merge failed: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.merged, 'Response must contain merged entity');
    assert.equal(r.body.absorbedId, absorbed._id);
    assert.ok(r.body.relinked);

    // Survivor exists with merged tags
    const surv = await readRecord(A, token(), SPACE, 'entities', survivor._id);
    assert.equal(surv.status, 200);
    assert.ok(surv.body.tags.includes('tag-a'));
    assert.ok(surv.body.tags.includes('tag-b'));

    // Absorbed is gone
    const abs = await readRecord(A, token(), SPACE, 'entities', absorbed._id);
    assert.equal(abs.status, 404);
  });

  it('edges are relinked from absorbed to survivor', async () => {
    const survivor = await createEntity('merge-surv-edge', 'node');
    const absorbed = await createEntity('merge-abs-edge', 'node');
    const other = await createEntity('merge-other-edge', 'node');

    // Create edge: absorbed → other
    const edge = await createEdge(absorbed._id, other._id, 'connects');

    await merge(survivor._id, absorbed._id);

    /*
     * RE-KEYED since 3.6, so the edge is no longer at the id it was created under. An edge's `_id` is derived
     * from `(from, to, label)`, and the relink changed `from` — leaving it under the old id is what let two
     * peers disagree about one relationship.
     *
     * Found by its TRIPLET rather than by computing the derivation here: `upsertEdge` is keyed on the triplet,
     * so re-creating it lands on the stored row, and the id that comes back IS the id the relink chose. That
     * is the convergence being claimed, stated as behaviour rather than as an equality against a function the
     * implementation could get wrong in the same way twice.
     */
    const again = await createEdge(survivor._id, other._id, 'connects');
    assert.equal(again.from, survivor._id);
    assert.equal(again.to, other._id);

    const e = await readRecord(A, token(), SPACE, 'edges', again._id);
    assert.equal(e.status, 200, 'the relinked edge must be readable at its derived id');
    assert.equal(e.body.from, survivor._id);
    assert.equal(e.body.to, other._id);

    const old = await readRecord(A, token(), SPACE, 'edges', edge._id);
    assert.equal(old.status, 404, 'the pre-relink id must be gone, not left as a second row for one edge');
    assert.notEqual(again._id, edge._id, 'the identity changed, so the id must have changed with it');
  });

  it('a relinked edge keeps what the relationship IS', async () => {
    // The re-key is a delete and an insert, so everything describing the relationship has to survive the
    // move. Rebuilding the document instead would silently reset an edge's provenance on every merge.
    const survivor = await createEntity('merge-surv-carry', 'node');
    const absorbed = await createEntity('merge-abs-carry', 'node');
    const other = await createEntity('merge-other-carry', 'node');

    const r = await post(A, token(), `/api/brain/spaces/${SPACE}/edges`, {
      from: absorbed._id, to: other._id, label: 'carries',
      description: 'why this link exists', tags: ['provenance'], properties: { origin: 'import' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    await merge(survivor._id, absorbed._id);

    const again = await createEdge(survivor._id, other._id, 'carries');
    const e = await readRecord(A, token(), SPACE, 'edges', again._id);
    assert.equal(e.status, 200);
    assert.equal(e.body.description, 'why this link exists');
    assert.deepEqual(e.body.tags, ['provenance']);
    assert.equal(e.body.properties?.origin, 'import');
    assert.equal(e.body.createdAt, r.body.createdAt, 'the relationship was not created again, it was moved');
  });

  it('a label change re-keys the edge too', async () => {
    /*
     * The other path that changes what an edge IS. `updateEdgeById` accepts a new label, and a label is part
     * of the identity the id derives from — so a patched label used to leave the edge under an id that no
     * longer described it, with the same consequence on the next sync.
     */
    const a = await createEntity('relabel-a', 'node');
    const b = await createEntity('relabel-b', 'node');
    const edge = await createEdge(a._id, b._id, 'old_label');

    const p = await patch(A, token(), `/api/brain/spaces/${SPACE}/edges/${edge._id}`, { label: 'new_label' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.label, 'new_label');
    assert.notEqual(p.body._id, edge._id, 'a new label is a new identity, so it is a new id');

    const moved = await readRecord(A, token(), SPACE, 'edges', p.body._id);
    assert.equal(moved.status, 200, 'the response must name an id that resolves');
    assert.equal(moved.body.label, 'new_label');

    const gone = await readRecord(A, token(), SPACE, 'edges', edge._id);
    assert.equal(gone.status, 404, 'the old id must not survive beside the new one');

    // And it converges: creating the same triplet lands on the row the patch produced.
    const again = await createEdge(a._id, b._id, 'new_label');
    assert.equal(again._id, p.body._id);
  });

  it('a field removed alongside the label is removed from the STORED edge', async () => {
    /*
     * The re-key builds the new document from the stored one, so a removal it is not told about is spread
     * straight back in — and the removal was applied to the RESPONSE only, so the caller was told the field
     * was gone while the row kept it. A GET immediately after the PATCH contradicted the 200 that made it.
     *
     * Nothing covered this: the deleteFields suite patches an edge without a label, and the re-key cases
     * patch a label without deleteFields. The defect lived exactly in the intersection.
     */
    const a = await createEntity('unset-a', 'node');
    const b = await createEntity('unset-b', 'node');
    const r = await post(A, token(), `/api/brain/spaces/${SPACE}/edges`, {
      from: a._id, to: b._id, label: 'before', description: 'should not survive', tags: ['gone'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const p = await patch(A, token(), `/api/brain/spaces/${SPACE}/edges/${r.body._id}`, {
      label: 'after', deleteFields: ['description', 'tags'],
    });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.description, undefined, 'the response must not carry the removed field');

    const stored = await readRecord(A, token(), SPACE, 'edges', p.body._id);
    assert.equal(stored.status, 200, 'the response named an id that does not resolve');
    assert.equal(stored.body.description, undefined,
      'the removal was reported and not made — the stored edge still carries the field');
    assert.ok(!stored.body.tags || stored.body.tags.length === 0,
      `tags survived the move: ${JSON.stringify(stored.body.tags)}`);
  });

  it('a label change onto an identity that already exists is a 409, not a 500', async () => {
    /*
     * A caller error — they named a relationship that exists — so it must not read as a server fault. The
     * guard runs before anything is written, so the edge they tried to move is still there afterwards; a
     * refusal that had destroyed it would be far worse than the collision it prevented.
     */
    const a = await createEntity('taken-a', 'node');
    const b = await createEntity('taken-b', 'node');
    const first = await createEdge(a._id, b._id, 'occupied');
    const second = await createEdge(a._id, b._id, 'movable');

    const p = await patch(A, token(), `/api/brain/spaces/${SPACE}/edges/${second._id}`, { label: 'occupied' });
    assert.equal(p.status, 409, `expected a conflict, got ${p.status}: ${JSON.stringify(p.body)}`);
    assert.equal(p.body.error, 'edge_identity_taken');
    assert.equal(p.body.existingId, first._id, 'the refusal must name the edge in the way');

    const survivor = await readRecord(A, token(), SPACE, 'edges', second._id);
    assert.equal(survivor.status, 200, 'the refused edge was destroyed by the refusal');
    assert.equal(survivor.body.label, 'movable', 'the refused edge was partially updated');
  });

  it('a patch that does not touch the label leaves the id alone', async () => {
    // The common case, and the one a re-key must not reach: delete-and-inserting for a description edit
    // would write a tombstone and briefly remove the edge from every peer for nothing.
    const a = await createEntity('nokey-a', 'node');
    const b = await createEntity('nokey-b', 'node');
    const edge = await createEdge(a._id, b._id, 'stable');

    const p = await patch(A, token(), `/api/brain/spaces/${SPACE}/edges/${edge._id}`, { description: 'edited' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body._id, edge._id, 'an ordinary field patch must not move the edge');

    const still = await readRecord(A, token(), SPACE, 'edges', edge._id);
    assert.equal(still.status, 200);
    assert.equal(still.body.description, 'edited');
  });

  it('memories are relinked from absorbed to survivor', async () => {
    const survivor = await createEntity('merge-surv-mem', 'node');
    const absorbed = await createEntity('merge-abs-mem', 'node');

    const mem = await createMemory('linked to absorbed', [absorbed._id], ['merge-test']);

    await merge(survivor._id, absorbed._id);

    const m = await readRecord(A, token(), SPACE, 'facts', mem._id);
    assert.equal(m.status, 200);
    assert.ok(m.body.entityIds.includes(survivor._id), 'Memory entityIds should contain survivor');
    assert.ok(!m.body.entityIds.includes(absorbed._id), 'Memory entityIds should NOT contain absorbed');
  });

  it('self-merge is rejected with 400', async () => {
    const entity = await createEntity('merge-self', 'node');
    const r = await merge(entity._id, entity._id);
    assert.equal(r.status, 400);
  });

  it('duplicate edges are auto-deleted when 100% identical after relink', async () => {
    const survivor = await createEntity('merge-surv-dup', 'node');
    const absorbed = await createEntity('merge-abs-dup', 'node');
    const target = await createEntity('merge-target-dup', 'node');

    // Create identical edges from both to target
    const survivorEdge = await createEdge(survivor._id, target._id, 'links-to');
    const absorbedEdge = await createEdge(absorbed._id, target._id, 'links-to');

    const r = await merge(survivor._id, absorbed._id);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.deletedDuplicateEdgeIds), 'Should report deleted duplicate edge IDs');
    assert.ok(r.body.deletedDuplicateEdgeIds.length > 0, 'One duplicate edge should be auto-deleted');

    // Original survivor edge still exists
    const se = await readRecord(A, token(), SPACE, 'edges', survivorEdge._id);
    assert.equal(se.status, 200);

    // Absorbed edge should be tombstoned
    const ae = await readRecord(A, token(), SPACE, 'edges', absorbedEdge._id);
    assert.equal(ae.status, 404);
  });

  it('self-loop edge on absorbed becomes survivor→survivor', async () => {
    const survivor = await createEntity('merge-surv-loop', 'node');
    const absorbed = await createEntity('merge-abs-loop', 'node');

    // Self-loop: absorbed → absorbed
    const loop = await createEdge(absorbed._id, absorbed._id, 'self-ref');

    const r = await merge(survivor._id, absorbed._id);
    assert.equal(r.status, 200);

    // The self-loop edge should now be survivor → survivor, at the id that identity derives — BOTH ends
    // moved, so this is the case where the re-key matters most and the old id is furthest from the truth.
    const again = await createEdge(survivor._id, survivor._id, 'self-ref');
    const e = await readRecord(A, token(), SPACE, 'edges', again._id);
    assert.equal(e.status, 200);
    assert.equal(e.body.from, survivor._id, 'Self-loop from should be relinked to survivor');
    assert.equal(e.body.to, survivor._id, 'Self-loop to should be relinked to survivor');
    assert.equal((await readRecord(A, token(), SPACE, 'edges', loop._id)).status, 404,
      'the pre-relink id must be gone rather than left beside the relinked edge');
  });

  it('property conflict requires resolution', async () => {
    const survivor = await createEntity('merge-surv-conflict', 'node', { color: 'red' });
    const absorbed = await createEntity('merge-abs-conflict', 'node', { color: 'blue' });

    // Without resolution → should return plan with conflicts
    const r1 = await merge(survivor._id, absorbed._id);
    assert.equal(r1.status, 409, 'Should return 409 for unresolved conflicts');

    // With resolution
    const r2 = await merge(survivor._id, absorbed._id, [
      { key: 'color', resolution: 'survivor' },
    ]);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.merged.properties.color, 'red');
  });
});
