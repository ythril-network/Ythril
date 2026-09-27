/**
 * Sync between a peer that encrypts files at rest and one that does not (F-43).
 *
 * Instance D carries a master secret in the test stack and A does not. What this pins:
 *
 * - **A file arriving on the keyed peer is stored encrypted.** The bytes on the wire are plaintext and the receiver
 *   applies its OWN rule; a raw read of D's disk shows no plaintext.
 * - **It still reads as what was uploaded**, on D's download, and its size on D's manifest is the PLAINTEXT size —
 *   the manifest is what peers compare, so a ciphertext size there would read as a change on every cycle.
 * - **The other way round sends plaintext.** A file written on D reaches the keyless A as the file, not as
 *   ciphertext A cannot read.
 *
 * Run: node --test testing/sync/a-keyed-peer-stores-what-it-receives-encrypted.test.js
 * Pre-requisite: docker compose -f testing/docker-compose.test.yml up && node testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import path from 'node:path';
import { INSTANCES, post, del, reqJson, getInstanceId, createTestSpace, dockerExec } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const MARKER = `F43-PLAINTEXT-MARKER-${RUN}`;

let tokenA, tokenD, networkId, SPACE, removeSpace;

async function upload(base, token, filePath, content) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  assert.ok([201, 202].includes(r.status), `upload ${filePath} on ${base}: ${r.status} ${await r.text()}`);
}

async function download(base, token, filePath) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(filePath)}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.text() };
}

/** Trigger a sync from A and poll until `ok()` holds. */
async function syncUntil(ok, timeout = 60_000) {
  await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 2000));
    if (await ok()) return;
    if (++n % 4 === 0) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
  }
  throw new Error(`condition not met after ${timeout}ms`);
}

/** The raw bytes a container keeps on disk for a stored file, base64 so binary survives the shell. */
function rawOnDisk(container, filePath) {
  const abs = `/data/files/${SPACE}/${filePath}`;
  return Buffer.from(dockerExec(`docker exec ${container} node -e "process.stdout.write(require('fs').readFileSync('${abs}').toString('base64'))"`), 'base64');
}

describe('sync between a keyed and a keyless peer', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenD = fs.readFileSync(path.join(CONFIGS, 'd', 'token.txt'), 'utf8').trim();
    ({ id: SPACE, remove: removeSpace } = await createTestSpace('f43-at-rest', [[INSTANCES.a, tokenA], [INSTANCES.d, tokenD]]));

    const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: `F-43 at rest ${RUN}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
    assert.equal(net.status, 201, JSON.stringify(net.body));
    networkId = net.body.id;
    const peer = await post(INSTANCES.d, tokenD, '/api/tokens', { name: `f43-peer-${RUN}`, peerInstanceId: getInstanceId('ythril-a') });
    assert.equal(peer.status, 201, JSON.stringify(peer.body));
    const add = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'f43-instance-d', label: 'F43D', url: 'http://ythril-d:3200', token: peer.body.plaintext, direction: 'both',
    });
    if (add.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${add.body.roundId}`, { vote: 'yes' });
    else assert.equal(add.status, 201, JSON.stringify(add.body));
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await removeSpace?.();
  });

  it('a file from the keyless peer is ciphertext on the keyed one, and reads back as uploaded', async () => {
    const filePath = `from-a-${RUN}.txt`;
    const content = `${MARKER} written on A`;
    await upload(INSTANCES.a, tokenA, filePath, content);
    await syncUntil(async () => (await download(INSTANCES.d, tokenD, filePath)).body === content);

    assert.ok(!rawOnDisk('ythril-d', filePath).includes(Buffer.from(MARKER)), "D's disk holds the plaintext of a file it received");
    assert.ok(rawOnDisk('ythril-a', filePath).includes(Buffer.from(MARKER)), 'A has no secret and must store what it was given');

    const m = await reqJson(INSTANCES.d, tokenD, `/api/sync/manifest?spaceId=${SPACE}`);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const entry = m.body.manifest.find(e => e.path === filePath);
    assert.ok(entry, `D's manifest does not list ${filePath}`);
    assert.equal(entry.size, Buffer.byteLength(content), "D's manifest publishes the ciphertext size, which every peer reads as a change");
  });

  it('a file from the keyed peer reaches the keyless one as the file, not as ciphertext', async () => {
    const filePath = `from-d-${RUN}.txt`;
    const content = `${MARKER} written on D`;
    await upload(INSTANCES.d, tokenD, filePath, content);
    assert.ok(!rawOnDisk('ythril-d', filePath).includes(Buffer.from(MARKER)), 'D stored its own upload in plaintext');
    await syncUntil(async () => (await download(INSTANCES.a, tokenA, filePath)).body === content);
    assert.ok(rawOnDisk('ythril-a', filePath).includes(Buffer.from(MARKER)), 'A received something other than the plaintext');
  });
});
