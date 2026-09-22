/**
 * Entity references end to end: a reference that cannot resolve is REFUSED, not stored.
 *
 * The reported defect was that the write paths disagreed — `saveFact` took entity names and silently
 * stored the memory unlinked when a name did not resolve, `save_edge` demanded a UUID, and several
 * paths (update_memory, file metadata, bulk memory items) validated nothing at all. In a graph store a
 * dropped link is invisible: the write returns success and the gap only shows up later as a traversal
 * that comes back empty.
 *
 * These drive the real API, because that is the only place the contract is observable to a caller.
 * The unit-level rules live in `standalone/entity-refs.test.js`.
 *
 * Run: node --test testing/integration/entity-refs.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, delWithBody, readCollection } from '../sync/helpers.js';
import { linkInputSchemasFor } from '../../server/dist/brain/write-connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const RUN = Date.now();
const SPACE = `refs-${RUN}`;
const NONEXISTENT_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

let token;
let entityId;

describe('entity references must resolve', () => {
  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: 'Refs' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const ent = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
      name: `Traefik-${RUN}`, type: 'concept',
    });
    assert.equal(ent.status, 201, JSON.stringify(ent.body));
    entityId = ent.body._id;
    assert.match(entityId, /^[0-9a-f-]{36}$/i, 'entity ids are UUIDs');
  });

  after(async () => {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  });

  it('a real entity id links, and the link is readable back', async () => {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: 'links to a real entity', entityIds: [entityId],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.entityIds, [entityId], 'the link must actually be stored');
  });

  it('a NAME where an id belongs is refused, and the error names the value', async () => {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: 'links by name', entityIds: [`Traefik-${RUN}`],
    });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(JSON.stringify(r.body), /Traefik/, 'the error must name the offending value');
  });

  it('a well-formed UUID that does not exist is refused too', async () => {
    // Format alone was never the point: a syntactically perfect id pointing at nothing stores just
    // as silently as a name did.
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: 'links to a ghost', entityIds: [NONEXISTENT_UUID],
    });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('nothing was stored by the refused writes', async () => {
    // The point of a hard error is that the record does not exist afterwards. If a refusal still
    // wrote the row (minus the link), we would have swapped a silent unlinked write for a noisy one.
    const list = await readCollection(INSTANCES.a, token, SPACE, 'facts');
    assert.equal(list.status, 200);
    const facts = (list.results ?? []).map(m => m.fact);
    assert.ok(!facts.includes('links by name'), 'a refused write must not be stored');
    assert.ok(!facts.includes('links to a ghost'), 'a refused write must not be stored');
  });

  it('file metadata refuses a bad reference on every one of its link fields', async () => {
    // This surface had no validation at all — not even the strict gate the other routes carried.
    const write = await post(INSTANCES.a, token, `/api/files/${SPACE}?path=${encodeURIComponent('note.txt')}`, {
      content: 'hello',
    });
    assert.ok([200, 201, 202].includes(write.status), JSON.stringify(write.body));

    /*
     * DERIVED from the classes a FILE can hold, and the COUNT is out of the title (`Q-6`, 2026-09-07).
     *
     * It named the three fields a file carries today and said "three" out loud. A seventh link class would
     * give a file a fourth, and this case would go on asserting about the old three while its title claimed
     * all of them. The source moved in 5.0 — the link arrays went and `linkEntities` and its siblings are
     * the input — and the derivation moved with it rather than becoming a list.
     */
    const fileLinkFields = Object.keys(linkInputSchemasFor('file'));
    assert.ok(fileLinkFields.length >= 3,
      `only ${fileLinkFields.length} link field(s); the three a file carries are the minimum`);
    for (const field of fileLinkFields) {
      const r = await patch(
        INSTANCES.a, token,
        `/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent('note.txt')}`,
        { [field]: ['not-an-id'] },
      );
      assert.equal(r.status, 400, `${field} should have been refused, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.match(JSON.stringify(r.body), new RegExp(field), 'the error must name the field');
    }
  });

  it('an edge to a nonexistent entity is refused', async () => {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges`, {
      from: entityId, to: NONEXISTENT_UUID, label: 'points-nowhere',
    });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a space that opts out keeps the lax behaviour — the escape hatch still works', async () => {
    // Staged imports reference records that do not exist yet; that case is why the opt-out survives.
    const lax = `refs-lax-${RUN}`;
    const created = await post(INSTANCES.a, token, '/api/spaces', { id: lax, label: 'Lax' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    try {
      const set = await patch(INSTANCES.a, token, `/api/spaces/${lax}`, { meta: { strictLinkage: false } });
      assert.equal(set.status, 200, JSON.stringify(set.body));

      const r = await post(INSTANCES.a, token, `/api/brain/spaces/${lax}/facts`, {
        fact: 'forward reference during an import', entityIds: ['created-later'],
      });
      assert.equal(r.status, 201, `the opt-out must still accept a dangling ref: ${JSON.stringify(r.body)}`);
    } finally {
      await delWithBody(INSTANCES.a, token, `/api/spaces/${lax}`, { confirm: true }).catch(() => {});
    }
  });
});
