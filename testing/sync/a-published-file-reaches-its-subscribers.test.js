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

/**
 * Sync from both ends each poll: whichever end moves files, a passing test must not depend on guessing it.
 *
 * On a timeout it reports the last sync answer from each end, and `what` may be a function that goes and looks:
 * the CI container dump keeps only the tail of each log, so a failure early in the run leaves nothing else.
 */
async function syncUntil(condition, what) {
  const last = {};
  await waitFor(async () => {
    last.b = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/sync?wait=true`, {});
    last.a = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync?wait=true`, {});
    return condition();
  }, 60_000, 2_000, async () => `${typeof what === 'function' ? await what() : what}; last sync answers: `
    + `B ${last.b?.status} ${JSON.stringify(last.b?.body)}, A ${last.a?.status} ${JSON.stringify(last.a?.body)}`);
}

/** The file's metadata record as one end holds it — the fields the Q-69 case decides on. */
async function fileMetaOn(base, token) {
  const q = await post(base, token, '/api/filter', { space: SPACE, collection: 'files', filter: { path: FILE }, limit: 1 });
  const rows = q.body?.results ?? (typeof q.body?.text === 'string' ? JSON.parse(q.body.text) : []);
  return rows[0];
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

  it('the subscriber holds the publisher\'s record of a pushed file, not one it stamped itself', async () => {
    // The publisher PUSHES the bytes to the subscriber's upload door. That door stored them as a local upload: this
    // instance's next seq, this instance as the author of a new file, and a description derived here — so the
    // subscriber's copy tied or outranked the publisher's next edit, which then never landed (seen in CI as Q-69).
    // An arrival is recorded as the publisher's, whichever door brought the bytes (Q-143, the push half).
    await syncUntil(async () => {
      const [a, b] = [await fileMetaOn(INSTANCES.a, tokenA), await fileMetaOn(INSTANCES.b, tokenB)];
      return a !== undefined && b !== undefined && a.seq === b.seq;
    }, async () => 'the subscriber never held the publisher\'s seq for the file: '
      + `B ${JSON.stringify((await fileMetaOn(INSTANCES.b, tokenB))?.seq)}, A ${JSON.stringify((await fileMetaOn(INSTANCES.a, tokenA))?.seq)}`);
    const [a, b] = [await fileMetaOn(INSTANCES.a, tokenA), await fileMetaOn(INSTANCES.b, tokenB)];
    const authored = d => ({ seq: d.seq, author: d.author?.instanceId, updatedAt: d.updatedAt, description: d.description, tags: d.tags });
    assert.deepEqual(authored(a), authored(b), 'the subscriber\'s copy of a pushed file is not the publisher\'s record');
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
      const doc = await fileMetaOn(INSTANCES.a, tokenA);
      return doc?.description === `described ${RUN}` && (doc.tags ?? []).includes('onboarding');
    }, async () => {
      const pick = d => d && { seq: d.seq, description: d.description, descriptionSource: d.descriptionSource, tags: d.tags,
        author: d.author?.instanceId, createdAt: d.createdAt, updatedAt: d.updatedAt, sha256: d.sha256, embeddingStatus: d.embeddingStatus };
      return 'the description and tags never reached the subscriber: '
        + `B holds ${JSON.stringify(pick(await fileMetaOn(INSTANCES.b, tokenB)))}, `
        + `A holds ${JSON.stringify(pick(await fileMetaOn(INSTANCES.a, tokenA)))}`;
    });
  });

  it('a delete on the publisher removes the subscriber\'s copy', async () => {
    const r = await fetch(`${INSTANCES.b}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` } });
    assert.ok(r.status < 300, `delete answered ${r.status}`);
    await syncUntil(async () => (await readFile(INSTANCES.a, tokenA)).status === 404, 'the deleted file stayed on the subscriber');
  });
});
