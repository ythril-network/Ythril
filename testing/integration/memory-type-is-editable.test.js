/**
 * A memory's `type` can be SET on create, CHANGED on update, and CLEARED — over REST.
 *
 * ## What was measured
 *
 * The memories tab has sorted and filtered by `type` since #836, and nothing in the UI could write one. Adding the
 * control surfaced a server gap underneath it: `POST` read `type`, and `PATCH` never destructured it, so a caller
 * changing a memory's type got **200 and no change**.
 *
 * Found by driving the UI rather than by reading: the browser sent `{"type":"note", …}`, the request succeeded, and the
 * stored record still said `decision`. `updateFact` had accepted `type` and written `$set.type` all along — the field
 * was plumbed the whole way down and lost at the door.
 *
 * That is the same shape as the `skip` parameter the fleet integrator reported on `POST /query`: a permissive body, a success status,
 * and a silently ignored field. Worth a test at the API level rather than only in the client, because the client is not
 * where it broke.
 *
 * ## The `''` case is not decoration
 *
 * An omitted field on a PATCH means *leave it alone*, so clearing a type has to reach the API as an explicit empty
 * string. Without that distinction a type could be set and never unset — the box would refuse to empty, and nothing
 * would report an error.
 *
 * Run: node --test testing/integration/memory-type-is-editable.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, del, delWithBody, readRecord } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `memtype-${RUN}`;

let token;

const create = (body) => post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, body);
const edit = (id, body) => patch(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts/${id}`, body);
const read = async (id) => (await readRecord(INSTANCES.a, token, SPACE, 'facts', id)).body;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token, '/api/spaces', {
    id: SPACE, label: SPACE,
    // `warn` rather than `strict`: this file is about the type FIELD, not about property validation refusing a write.
    meta: { validationMode: 'warn', typeSchemas: { fact: { decision: {}, note: {} } } },
  });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
});

after(async () => {
  await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a memory type survives create, update and clear', () => {
  it('is stored on create', async () => {
    const r = await create({ fact: `created with a type ${RUN}`, type: 'decision' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.type, 'decision');
    assert.equal((await read(r.body._id)).type, 'decision', 'and it must be there when read back');
  });

  it('CHANGES on update — this is what silently did nothing', async () => {
    const id = (await create({ fact: `to be retyped ${RUN}`, type: 'decision' })).body._id;
    const r = await edit(id, { type: 'note' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await read(id)).type, 'note',
      'the PATCH answered 200 and the stored type did not change — the handler dropped the field');
  });

  it('CLEARS on an explicit empty string', async () => {
    // The unset path. Nothing else can express it: an absent field means "leave it alone".
    const id = (await create({ fact: `to be cleared ${RUN}`, type: 'decision' })).body._id;
    assert.equal((await edit(id, { type: '' })).status, 200);
    const after = await read(id);
    assert.ok(!after.type, `type should be empty, got ${JSON.stringify(after.type)}`);
  });

  it('is LEFT ALONE when the field is absent', async () => {
    // The other half of the clear case, and the one that makes it safe: a PATCH of some other field must not wipe the
    // type. Without this, "absent means leave alone" is an assumption rather than a tested rule.
    const id = (await create({ fact: `keep my type ${RUN}`, type: 'decision' })).body._id;
    assert.equal((await edit(id, { description: 'an unrelated edit' })).status, 200);
    const after = await read(id);
    assert.equal(after.type, 'decision', 'an unrelated PATCH must not clear the type');
    assert.equal(after.description, 'an unrelated edit');
  });

  it('accepts a type the SCHEMA does not declare — there is no allowlist', async () => {
    // Deliberate, and the reason the UI control is free text with suggestions rather than a closed select. `validateFact`
    // uses `type` only to look up `typeSchemas.memory[type]`; unlike chrono there is no `getAllowedFactTypes`. A UI
    // that offered only declared types would be stricter than the API — so if this ever starts refusing, the control
    // must change with it.
    const r = await create({ fact: `undeclared type ${RUN}`, type: 'observation' });
    assert.equal(r.status, 201, `an undeclared memory type was refused: ${JSON.stringify(r.body)}`);
    assert.equal((await read(r.body._id)).type, 'observation');
  });

  it('refuses a non-string type rather than coercing it', async () => {
    const id = (await create({ fact: `bad type ${RUN}` })).body._id;
    const r = await edit(id, { type: 42 });
    assert.equal(r.status, 400, `a numeric type was accepted: ${JSON.stringify(r.body)}`);
  });
});
