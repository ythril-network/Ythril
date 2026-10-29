/**
 * A file one instance holds on disk under a decomposed (NFD) name is pulled by its peer in one sync cycle, and the peer stores it
 * under one name (Q-581).
 *
 * ## What it proves, between two real instances
 *
 * B holds `Dossier été/Café.txt` with both names spelt as a macOS peer wrote them before 6.0 (`normalize('NFD')`), straight on its
 * disk: every upload door normalises a name to NFC, so no API call can make this file, and the one way B really comes to hold it is
 * an arrival written by a peer that kept its names decomposed. A (a closed network, both directions) runs ONE sync cycle, and then:
 *
 *  1. A holds the file's bytes, read through its own door by the NFC key. B's manifest used to advertise the on-disk spelling and its
 *     byte door looked only at the NFC resolution, so A asked for a name that was nowhere: a 404 every cycle, and nothing held.
 *  2. A holds it under ONE name: one file on its disk, spelt NFC, and one record in the space, whose path is the NFC key. A second
 *     fetch under the other spelling would have been a second copy of the one file.
 *  3. B's copy is where it was: its bytes stay under the decomposed spelling, and no second spelling appears beside it. Nothing is
 *     renamed, moved or copied on the instance that holds the file.
 *
 * The suites beside this one check the manifest, the byte door and the Merkle root each on its own (the standalone
 * `a-file-held-under-a-decomposed-name-is-fetched-by-its-key-db` and `a-merkle-root-is-the-same-for-nfd-and-nfc-copies-db`), never a
 * pull between two instances; this is the case that does.
 *
 * Run: node --test testing/sync/a-file-held-under-a-decomposed-name-reaches-its-peer.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, dockerExec, createTestSpace, mirroredNetwork } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();

const DIR = 'Dossier été';
const NAME = `Café ${RUN}.txt`;
const KEY = `${DIR}/${NAME}`.normalize('NFC');
const NFD_DIR = DIR.normalize('NFD');
const NFD_NAME = NAME.normalize('NFD');
const CONTENT = `held decomposed ${RUN}\n`;

let tokenA, tokenB, SPACE, removeSpace, net;

/** Run `body` (a function of `a`, the argument) inside `container`; the argument and the answer travel as base64, so no name meets the shell. */
function inContainer(container, arg, body) {
  const b64 = Buffer.from(JSON.stringify(arg), 'utf8').toString('base64');
  const script = `const a=JSON.parse(Buffer.from('${b64}','base64').toString());const fs=require('fs'),p=require('path');`
    + `const out=(${body.toString()})(a,fs,p);process.stdout.write(Buffer.from(JSON.stringify(out??null),'utf8').toString('base64'));`;
  const run = Buffer.from(script, 'utf8').toString('base64');
  const raw = dockerExec(`docker exec ${container} node -e "eval(Buffer.from('${run}','base64').toString())"`).trim();
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

/** Every file under the space's files folder on `container`, as the relative path the disk spells it (a directory's name is part of it). */
const filesOnDisk = (container) => inContainer(container, { root: `/data/files/${SPACE}` }, (a, fs, p) => {
  const found = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p.join(dir, e.name), next); else found.push(next);
    }
  };
  walk(a.root, '');
  return found;
});

/** Put a file on `container`'s disk under exactly the spelling given: the door every API upload would have normalised away. */
const writeOnDisk = (container, rel, content) => inContainer(container, { root: `/data/files/${SPACE}`, rel, content }, (a, fs, p) => {
  const abs = p.join(a.root, a.rel);
  fs.mkdirSync(p.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, a.content);
  return true;
});

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  ({ id: SPACE, remove: removeSpace } = await createTestSpace('nfd-pull', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]));
  // Only a file system that keeps a decomposed name as written can hold the fixture; the test says so rather than pass on one that cannot.
  writeOnDisk('ythril-b', `${NFD_DIR}/${NFD_NAME}`, CONTENT);
  assert.ok(filesOnDisk('ythril-b').includes(`${NFD_DIR}/${NFD_NAME}`),
    `the test stack's file system did not keep the decomposed name: B lists ${JSON.stringify(filesOnDisk('ythril-b'))}`);
  net = await mirroredNetwork({ label: `nfd-pull-${RUN}`, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
});

after(async () => {
  await net?.remove();
  await removeSpace?.();
});

describe('a file held under a decomposed name reaches its peer', () => {
  it('one sync cycle on the pulling end stores the file under its one NFC name', async () => {
    // One cycle, no polling: a pull that fails on the name fails every cycle, so waiting for a later one would only hide it.
    const cycle = await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {});
    assert.ok(cycle.status < 300, `the sync cycle on A answered ${cycle.status} ${JSON.stringify(cycle.body)}`);
    const said = `A's cycle answered ${JSON.stringify(cycle.body)}`;

    // 1. The bytes: A serves them by the key.
    const read = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(KEY)}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(read.status, 200, `A does not hold the file under its key after one cycle (${read.status}); ${said}`);
    assert.equal(await read.text(), CONTENT, 'A holds other bytes than B wrote');

    // 2. One name: one file on A's disk, spelt NFC, and one record in the space for it.
    assert.deepEqual(filesOnDisk('ythril-a'), [KEY], `A holds the file under other names than its one NFC key; ${said}`);
    const q = await post(INSTANCES.a, tokenA, '/api/filter', { space: SPACE, collection: 'files', filter: {}, limit: 50 });
    // The tool door carries the page in `data` (`Q-111`), so `text` is not parsed.
    const rows = q.body?.data?.results ?? q.body?.results ?? [];
    const named = rows.map(r => r.path ?? r._id).filter(p => typeof p === 'string' && p.normalize('NFC') === KEY);
    assert.deepEqual(named, [KEY], `A's records name the file other than once, by its NFC key: ${JSON.stringify(rows.map(r => r.path ?? r._id))}`);
  });

  it('the instance that holds the file still holds it under the spelling it had, and nothing beside it', () => {
    assert.deepEqual(filesOnDisk('ythril-b'), [`${NFD_DIR}/${NFD_NAME}`],
      'B\'s disk changed: the file was renamed, moved or copied on the instance that holds it');
  });
});
