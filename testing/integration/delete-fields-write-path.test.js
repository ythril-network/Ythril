/**
 * `deleteFields` against the real write path, for whole fields as well as nested keys.
 *
 * ## The report, and why it was believed on sight
 *
 * The canary operator, 2026-08-12T2140Z: `deleteFields: ["tags"]` is documented and fails with a Mongo path
 * conflict. Confirmed by reading `entities.ts` and `edges.ts` rather than by reproducing, because the cause is
 * total: the guard meant to suppress the `$set` was
 *
 *     if (updates.tags !== undefined || (deleteFieldsPaths && !$unset['tags'])) $set['tags'] = newTags;
 *
 * and `$unset` entries are written as `$unset['tags'] = ''` — Mongo's own convention. The empty string is FALSY,
 * so `!$unset['tags']` was always true, the `$set` was always applied, and the update reached Mongo with one path
 * in both `$set` and `$unset`. Mongo rejects the whole write.
 *
 * ## Why it survived this long, which is the part worth keeping
 *
 * **Nested paths were fine.** `deleteFields: ["properties.region"]` leaves `properties` present in the merged
 * view, so no `$unset` is written for it and the guard never mattered. Every example in the docs and the only
 * existing integration coverage (`schema-library.test.js`) used a nested path. So the broken half was the one
 * nobody had a test for, and the working half looked like proof the feature worked.
 *
 * That is why this file asserts BOTH shapes on BOTH record types. A test for the reported case alone would have
 * left the next person to discover that the two shapes go down different branches.
 *
 * ## The comparison that made the fix obvious
 *
 * `memory.ts` was already correct, and not by writing a better guard: it writes `$unset[field] = ''` and then
 * `delete $set[field]`, so the deletion is expressed by removing the `$set` rather than by testing the `$unset`
 * for truth. Both broken files also used the right idiom a few lines away for a different field — `'_expireAt' in
 * $unset`. Three surfaces, one correct, two wrong, and the correct test spelled out twice inside each wrong file.
 *
 * Run: node --test testing/integration/delete-fields-write-path.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, readRecord } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = 'general';

let token;

before(() => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

async function newEntity(extra = {}) {
  const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
    name: `DeleteFields-${RUN}-${Math.floor(performance.now() * 1000)}`,
    type: 'concept',
    description: 'to be removed',
    tags: ['keep-me', 'and-me'],
    properties: { region: 'eu', tier: 'core' },
    ...extra,
  });
  assert.equal(r.status, 201, `entity create failed: ${JSON.stringify(r.body)}`);
  return r.body._id;
}

async function newEdge() {
  const [a, b] = [await newEntity(), await newEntity()];
  const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges`, {
    from: a, to: b, label: `df-edge-${RUN}-${Math.floor(performance.now() * 1000)}`,
    description: 'to be removed',
    tags: ['keep-me', 'and-me'],
    properties: { region: 'eu', tier: 'core' },
    weight: 0.75,
  });
  assert.equal(r.status, 201, `edge create failed: ${JSON.stringify(r.body)}`);
  return r.body._id;
}

const patchEntity = (id, body) => patch(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities/${id}`, body);
const patchEdge = (id, body) => patch(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges/${id}`, body);
const getEntity = (id) => readRecord(INSTANCES.a, token, SPACE, 'entities', id);
const getEdge = (id) => readRecord(INSTANCES.a, token, SPACE, 'edges', id);

describe('deleteFields removes a WHOLE field — the reported failure', () => {
  it('an entity loses `tags`, and the write is not refused', async () => {
    const id = await newEntity();
    const r = await patchEntity(id, { deleteFields: ['tags'] });
    // The failure mode being pinned is a REFUSED WRITE, not a wrong value: Mongo answers "Updating the path
    // 'tags' would create a conflict at 'tags'" and nothing is applied. So the status is the assertion that
    // matters, and it is asserted before the value.
    assert.equal(r.status, 200, `deleteFields:["tags"] was refused: ${JSON.stringify(r.body)}`);
    const after = await getEntity(id);
    assert.equal(after.body.tags, undefined, 'tags must be gone from the stored record, not merely absent from the response');
    assert.equal(after.body.properties?.region, 'eu', 'deleting one field must not disturb the others');
  });

  it('an entity loses `description` and `properties` in one request', async () => {
    const id = await newEntity();
    const r = await patchEntity(id, { deleteFields: ['description', 'properties'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await getEntity(id);
    assert.equal(after.body.description, undefined);
    assert.equal(after.body.properties, undefined);
    assert.deepEqual(after.body.tags, ['keep-me', 'and-me'], 'the field NOT named must survive');
  });

  it('an edge loses `tags`, and `weight` too — four guards, all of them the same shape', async () => {
    const id = await newEdge();
    const r = await patchEdge(id, { deleteFields: ['tags', 'weight'] });
    assert.equal(r.status, 200, `deleteFields on an edge was refused: ${JSON.stringify(r.body)}`);
    const after = await getEdge(id);
    assert.equal(after.body.tags, undefined);
    assert.equal(after.body.weight, undefined);
  });
});

describe('deleteFields removes a NESTED key — the half that always worked', () => {
  // Kept because it is the branch the docs and the only prior coverage exercised. If a fix made whole-field
  // deletion work by writing `$unset` unconditionally, this is what would break: `properties` would vanish
  // entirely instead of losing one key, and the reported bug would be traded for a worse one.
  it('an entity loses one property and keeps the rest', async () => {
    const id = await newEntity();
    const r = await patchEntity(id, { deleteFields: ['properties.region'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await getEntity(id);
    assert.equal(after.body.properties?.region, undefined, 'the named key is gone');
    assert.equal(after.body.properties?.tier, 'core', 'and the sibling is not');
  });

  it('an edge loses one property and keeps the rest', async () => {
    const id = await newEdge();
    const r = await patchEdge(id, { deleteFields: ['properties.region'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await getEdge(id);
    assert.equal(after.body.properties?.region, undefined);
    assert.equal(after.body.properties?.tier, 'core');
  });
});

describe('deleteFields alongside an update of the same field', () => {
  it('the deletion wins, and the request is not refused', async () => {
    // The one case where a conflict is genuinely easy to produce: the caller sends `tags` AND asks for `tags` to
    // be deleted. `deleteFields` is documented as applying AFTER the normal merge, so the delete is the later
    // instruction and wins. What must NOT happen is the write being rejected — which is what happens when both
    // `$set` and `$unset` name the path.
    const id = await newEntity();
    const r = await patchEntity(id, { tags: ['replacement'], deleteFields: ['tags'] });
    assert.equal(r.status, 200, `a same-field update + delete was refused: ${JSON.stringify(r.body)}`);
    const after = await getEntity(id);
    assert.equal(after.body.tags, undefined, 'deleteFields applies after the merge, so it wins');
  });
});
