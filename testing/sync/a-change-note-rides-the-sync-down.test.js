/**
 * A change note rides a downward sync to the subscriber, and only downward (`F-42`).
 *
 * B publishes a pub/sub network; A joins it by key. B syncs with a note; A lists it as arrived from B. A subscriber
 * has nobody below it, so a note on A's sync is refused with 409 and the sync does not run. A caller that is not the
 * upstream cannot post notes into A's peer route.
 *
 * Run: node --test testing/sync/a-change-note-rides-the-sync-down.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f42-${RUN}`;
let tokenA, tokenB, networkId;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.b, tokenB, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `f42-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const k = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
  assert.ok(k.status < 300, JSON.stringify(k.body));
  const j = await post(INSTANCES.a, tokenA, '/api/networks/join-by-key', {
    publisherUrl: 'http://ythril-b:3200', inviteKey: k.body.inviteKey, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('the publisher sends a note down with its sync', () => {
  it('the sync answers with the queued note, and the subscriber receives it from the publisher', async () => {
    const text = `schema update ${RUN}: the Task type gained a due date`;
    const r = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/sync?wait=true`, { note: text, spaces: [SPACE] });
    assert.ok(r.status === 200 || r.status === 504, JSON.stringify(r.body));
    assert.ok(r.body.noteId, 'the answer names the note this sync carries');

    let arrived;
    await waitFor(async () => {
      const list = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/change-notes`);
      arrived = (list.body.notes ?? []).find(n => n._id === r.body.noteId);
      return !!arrived;
    }, 30_000, 1_500);
    assert.equal(arrived.note, text);
    assert.deepEqual(arrived.spaces, [SPACE]);
    assert.equal(arrived.generated, false);
    assert.ok(arrived.from, 'the sender is recorded');

    const out = await get(INSTANCES.b, tokenB, `/api/networks/${networkId}/change-notes?direction=out`);
    const sent = (out.body.notes ?? []).find(n => n._id === r.body.noteId);
    assert.deepEqual(sent.pendingFor, [], 'delivered to every member below');
  });
});

describe('nothing travels up or sideways', () => {
  it('a subscriber has nobody below it: its note is refused with 409, not dropped', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, { note: 'from below' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /no member below/);
  });

  it('a caller that is not the upstream cannot post notes into the peer route', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/change-notes`, {
      notes: [{ id: '5f0c4b1e-8d2a-4c3b-9e7f-1a2b3c4d5e6f', note: 'forged', spaces: [], author: 'x', generated: false, createdAt: new Date().toISOString() }],
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it('a bad direction is refused on the list door', async () => {
    assert.equal((await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/change-notes?direction=sideways`)).status, 400);
  });
});
