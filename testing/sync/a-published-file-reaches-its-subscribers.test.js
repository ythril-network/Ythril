/**
 * A file the publisher of a pub/sub network writes, changes or deletes reaches its subscriber (`Q-68`).
 *
 * Found 2026-09-26: `onboarding-guide.md`, written to `y-flows` on ythril-dev (the publisher), sat in dev's sync
 * manifest while no cycle moved it — dev's push reported `files: 0` and so did home's pull — though records and
 * space meta of the same network arrived. `file-sync.test.js` covers a CLOSED network only, where both ends push and
 * pull; nothing covered the one-way case.
 *
 * B publishes; A joins by key. Every step syncs from the PUBLISHER's side, because on a pub/sub the publisher is the
 * one that pushes (its member entry for the subscriber says `push`, the subscriber's says `pull`).
 *
 * Run: node --test testing/sync/a-published-file-reaches-its-subscribers.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, del, delWithBody, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q68-${RUN}`;
const FILE = 'guide/onboarding.md';
let tokenA, tokenB, networkId;

async function writeFile(base, token, content) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  return r.status;
}

async function readFile(base, token) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, text: r.ok ? await r.text() : '' };
}

/** Sync from both ends each poll: whichever end moves files, a passing test must not depend on guessing it. */
async function syncUntil(condition, what) {
  await waitFor(async () => {
    await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/sync?wait=true`, {});
    await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync?wait=true`, {});
    return condition();
  }, 60_000, 2_000, () => what);
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.b, tokenB, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q68-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const k = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
  assert.ok(k.status < 300, JSON.stringify(k.body));
  const j = await post(INSTANCES.a, tokenA, '/api/networks/join-by-key', {
    publisherUrl: 'http://ythril-b:3200', inviteKey: k.body.inviteKey, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  // The subscriber adopts the space on a cycle; the file steps below need it to exist there first.
  await syncUntil(async () => (await fetch(`${INSTANCES.a}/api/spaces/${SPACE}/meta`, { headers: { Authorization: `Bearer ${tokenA}` } })).ok,
    `space ${SPACE} was never adopted on A`);
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a published file reaches the subscriber', () => {
  it('a new file on the publisher arrives on the subscriber', async () => {
    assert.ok((await writeFile(INSTANCES.b, tokenB, `# Onboarding ${RUN}\n`)) < 300);
    await syncUntil(async () => (await readFile(INSTANCES.a, tokenA)).text.includes(`Onboarding ${RUN}`),
      'the new file never reached the subscriber');
  });

  it('a change on the publisher replaces the subscriber\'s copy, without a conflict', async () => {
    assert.ok((await writeFile(INSTANCES.b, tokenB, `# Onboarding ${RUN}, second edition\n`)) < 300);
    await syncUntil(async () => (await readFile(INSTANCES.a, tokenA)).text.includes('second edition'),
      'the changed file never replaced the subscriber\'s copy');
    const c = await fetch(`${INSTANCES.a}/api/conflicts?spaceId=${SPACE}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.deepEqual(((await c.json()).conflicts ?? []).map(x => x.originalPath), [], 'an upstream-only change is not a conflict');
  });

  it('the file\'s description and tags reach the subscriber too (Q-69)', async () => {
    // The metadata is its own replicated family. The push sent the whole stored record, local-only keys and all,
    // and the receiver's strict schema refused it whole — so the bytes arrived and the description never did.
    const r = await fetch(`${INSTANCES.b}/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent(FILE)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: `described ${RUN}`, tags: ['onboarding'] }),
    });
    assert.ok(r.status < 300, `meta edit answered ${r.status}`);
    await syncUntil(async () => {
      const q = await post(INSTANCES.a, tokenA, '/api/filter', { space: SPACE, collection: 'files', filter: { path: FILE }, limit: 1 });
      // The tool door carries the page in `data` (`Q-111`), so `text` is not parsed.
      const rows = q.body?.data?.results ?? q.body?.results ?? [];
      const doc = rows[0];
      return doc?.description === `described ${RUN}` && (doc.tags ?? []).includes('onboarding');
    }, 'the description and tags never reached the subscriber');
  });

  it('a delete on the publisher removes the subscriber\'s copy', async () => {
    const r = await fetch(`${INSTANCES.b}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` } });
    assert.ok(r.status < 300, `delete answered ${r.status}`);
    await syncUntil(async () => (await readFile(INSTANCES.a, tokenA)).status === 404, 'the deleted file stayed on the subscriber');
  });
});
