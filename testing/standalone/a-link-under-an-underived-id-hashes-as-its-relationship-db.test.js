/**
 * A link held under an id that does not derive from its endpoints hashes as the relationship it names, so two instances
 * holding one relationship under two ids report the same Merkle root (Q-222).
 *
 * ## The defect
 *
 * A link's id is derived from its endpoints (`linkIdFor`), and every writer here derives it. A row stored under another id
 * (a conversion's collision row, a link a peer pushed before the planner refused such ids) is still a record, and its leaf
 * was taken over its stored `_id` — so an instance holding the relationship under its derived id and one holding it under a
 * random id differed in that leaf for ever, with nothing missing on either side. The permanent false alarm the root exists
 * not to raise.
 *
 * ## What is asserted
 *
 * - the same relationship under the derived id in one space and a random v4 id in another gives equal roots;
 * - a link under its derived id hashes exactly as it did before (the leaf is the document's own `docLeaf`), so a network
 *   of mixed versions disagrees about nothing it did not already disagree about;
 * - sensitivity: a link to another endpoint, and the same relationship with another seq, move the root, so "equal" means
 *   something.
 *
 * Run: node --test testing/standalone/a-link-under-an-underived-id-hashes-as-its-relationship-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-identity-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const HERE = 'alpha';
const THERE = 'beta';

let mongo, merkle, spaceCollection, linkIdFor, retagToLocalSpace;

const root = async (space) => (await merkle.computeMerkleRoot(space)).root;

/** One link as the store holds it, under `_id` — retagged to the space as the arrival writer does. */
function link(space, _id, over = {}) {
  const doc = {
    _id, seq: 3, from: FROM, fromKind: 'fact', to: TO, toKind: 'entity',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', author: { instanceId: 'peer-a', instanceLabel: 'A' }, ...over,
  };
  retagToLocalSpace([doc], space);
  return doc;
}
const FROM = randomUUID();
const TO = randomUUID();

describe('a link under an underived id hashes as its relationship', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkidentity');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'link-identity-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: HERE, label: 'Here', folders: [] }, { id: THERE, label: 'There', folders: [] }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    merkle = await import('../../server/dist/brain/merkle.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    ({ retagToLocalSpace } = await import('../../server/dist/sync/upsert-plan.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const s of [HERE, THERE]) await mongo.col(spaceCollection(s, 'links')).deleteMany({});
  });

  const derived = () => linkIdFor(FROM, 'fact', TO, 'entity');

  it('one relationship under its derived id and under a random id gives the same root', async () => {
    await mongo.col(spaceCollection(HERE, 'links')).insertOne(link(HERE, derived()));
    await mongo.col(spaceCollection(THERE, 'links')).insertOne(link(THERE, randomUUID()));
    assert.equal(await root(THERE), await root(HERE),
      'a link under an id that does not derive hashes by that id, so one relationship is two records to the root');
  });

  it('a link under its derived id hashes exactly as its own document does, as it always did', async () => {
    const stored = link(HERE, derived());
    await mongo.col(spaceCollection(HERE, 'links')).insertOne(stored);
    // One leaf and no files: the root of a single leaf is that leaf.
    assert.equal(await root(HERE), merkle.docLeaf('links', stored),
      'the leaf of a link under its derived id changed — a mixed-version network would disagree about every link');
  });

  it('is still sensitive: another endpoint, or another seq, moves the root', async () => {
    await mongo.col(spaceCollection(HERE, 'links')).insertOne(link(HERE, derived()));
    const base = await root(HERE);

    await mongo.col(spaceCollection(THERE, 'links')).insertOne(link(THERE, randomUUID(), { to: randomUUID() }));
    assert.notEqual(await root(THERE), base, 'a link to another endpoint hashes as the same relationship');

    await mongo.col(spaceCollection(THERE, 'links')).deleteMany({});
    await mongo.col(spaceCollection(THERE, 'links')).insertOne(link(THERE, randomUUID(), { seq: 4 }));
    assert.notEqual(await root(THERE), base, 'a newer version of the relationship hashes as the old one');
  });
});
