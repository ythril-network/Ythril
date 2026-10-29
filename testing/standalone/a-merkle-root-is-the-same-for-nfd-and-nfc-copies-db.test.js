/**
 * Two instances holding one file's bytes under two spellings of its name agree on the space hash (Q-581).
 *
 * The Merkle root hashes each manifest entry as `file:<path>:<sha256>`. The manifest used to name a file by the spelling its disk keeps,
 * so a macOS-written decomposed name and the composed name of the same bytes gave two roots, and a network with `merkle: true` reported
 * a divergence for a space where nothing was wrong. The entry's `path` is now the file's NFC key, which is what the other instance's
 * copy is advertised under, and the root is the same.
 *
 * Seen red on the base: the two roots differ. The controls (different bytes, a different name) pin that the root still tells real
 * differences apart, so a fix that hashed nothing would not pass.
 *
 * The decomposed name is built with `normalize('NFD')`; a file system that normalises on write cannot hold the fixture and the suite skips.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-merkle-root-is-the-same-for-nfd-and-nfc-copies-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();

const NFC_NAME = 'Café.txt';
const NFD_NAME = NFC_NAME.normalize('NFD');
const SPACES = ['merkle-composed', 'merkle-decomposed', 'merkle-other'];

let door, computeMerkleRoot;
const rootOf = (space) => path.join(process.env['DATA_ROOT'], 'files', space);
const put = (space, name, content) => {
  fs.mkdirSync(rootOf(space), { recursive: true });
  fs.writeFileSync(path.join(rootOf(space), name), content);
};
const hashOf = async (space) => (await computeMerkleRoot(space)).root;

describe('the space hash does not depend on the Unicode form a disk keeps a name in', { skip }, () => {
  let keeps = false;
  before(async () => {
    door = await openPushDoor({ suite: 'merklenfd', spaces: SPACES.map(id => ({ id, label: id, folders: [], meta: { suppressEmbeddings: true } })) });
    ({ computeMerkleRoot } = await import('../../server/dist/brain/merkle.js'));
    assert.notEqual(NFD_NAME, NFC_NAME, 'the fixture name has no decomposed form');
    fs.mkdirSync(rootOf(SPACES[1]), { recursive: true });
    fs.writeFileSync(path.join(rootOf(SPACES[1]), `probe-${NFD_NAME}`), 'x');
    keeps = fs.readdirSync(rootOf(SPACES[1])).includes(`probe-${NFD_NAME}`);
  });
  after(async () => { await door?.close(); });

  it('identical bytes under a composed and a decomposed name give the same root', async (t) => {
    if (!keeps) { t.skip('this file system normalises a decomposed name on write: the fixture cannot exist here'); return; }
    fs.rmSync(rootOf(SPACES[1]), { recursive: true, force: true });
    put(SPACES[0], NFC_NAME, 'the same bytes');
    put(SPACES[1], NFD_NAME, 'the same bytes');
    assert.equal(await hashOf(SPACES[1]), await hashOf(SPACES[0]), 'one file under two spellings of its name hashed as two different files');
  });

  it('control: other bytes under the same name give another root', async (t) => {
    if (!keeps) { t.skip('this file system normalises a decomposed name on write'); return; }
    put(SPACES[2], NFC_NAME, 'other bytes');
    assert.notEqual(await hashOf(SPACES[2]), await hashOf(SPACES[0]));
  });

  it('control: the same bytes under another name give another root', async (t) => {
    if (!keeps) { t.skip('this file system normalises a decomposed name on write'); return; }
    fs.rmSync(rootOf(SPACES[2]), { recursive: true, force: true });
    put(SPACES[2], 'another-name.txt', 'the same bytes');
    assert.notEqual(await hashOf(SPACES[2]), await hashOf(SPACES[0]));
  });
});
