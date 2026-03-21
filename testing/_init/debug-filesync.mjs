#!/usr/bin/env node
/**
 * Debug script to manually trace file sync between A and B.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

const tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
const tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

const A = 'http://localhost:3200';
const B = 'http://localhost:3201';

async function jpost(base, token, path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function jget(base, token, path) {
  const r = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await r.json().catch(() => null) : await r.text().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  const RUN = Date.now();

  console.log('=== Step 1: Create network on A ===');
  const netR = await jpost(A, tokenA, '/api/networks', {
    label: `FSDebug-${RUN}`,
    type: 'closed',
    spaces: ['general'],
    votingDeadlineHours: 1,
  });
  console.log('Create network:', netR.status, JSON.stringify(netR.body).slice(0, 150));
  if (netR.status !== 201) process.exit(1);
  const networkId = netR.body.id;

  console.log('\n=== Step 2: Create peer token on B ===');
  const ptB = await jpost(B, tokenB, '/api/tokens', { name: `fs-peer-${RUN}` });
  console.log('Create peer token on B:', ptB.status, JSON.stringify(ptB.body).slice(0, 100));
  if (ptB.status !== 201) process.exit(1);
  const peerPlaintext = ptB.body.plaintext;

  console.log('\n=== Step 3: Add B as member of network ===');
  const addB = await jpost(A, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: `fs-b-${RUN}`,
    label: 'FS-B',
    url: 'http://ythril-b:3200',
    token: peerPlaintext,
    direction: 'both',
  });
  console.log('Add B:', addB.status, JSON.stringify(addB.body).slice(0, 200));
  if (addB.status === 202) {
    const vR = await jpost(A, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    console.log('Vote:', vR.status, JSON.stringify(vR.body).slice(0, 100));
  } else if (addB.status !== 201) {
    console.error('Add B failed');
    process.exit(1);
  }

  // Verify network config looks correct on A
  console.log('\n=== Step 4: Check network config on A ===');
  const netConfig = await jget(A, tokenA, `/api/networks/${networkId}`);
  console.log('Network config:', netConfig.status, JSON.stringify(netConfig.body).slice(0, 300));

  console.log('\n=== Step 5: Upload a file to A ===');
  const filePath = `debug-fs-${RUN}.txt`;
  const content = `hello-${RUN}`;
  const uploadR = await fetch(`${A}/api/files/general?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  const uploadBody = await uploadR.json().catch(() => null);
  console.log('Upload:', uploadR.status, JSON.stringify(uploadBody));

  console.log('\n=== Step 6: Trigger sync on A ===');
  const trigR = await jpost(A, tokenA, '/api/notify/trigger', { networkId });
  console.log('Trigger sync:', trigR.status, JSON.stringify(trigR.body).slice(0, 300));

  console.log('\n=== Step 7: Check if B has the file ===');
  await new Promise(r => setTimeout(r, 3000));
  const checkR = await fetch(`${B}/api/files/general?path=${encodeURIComponent(filePath)}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const checkBody = await checkR.text().catch(() => null);
  console.log('Check B file:', checkR.status, checkBody);

  console.log('\n=== Step 8: Check A manifest ===');
  const manifestR = await jget(A, tokenA, `/api/sync/manifest?spaceId=general&networkId=${networkId}`);
  console.log('A manifest:', manifestR.status, JSON.stringify(manifestR.body).slice(0, 300));

  console.log('\n=== DONE ===');
  process.exit(0);
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
