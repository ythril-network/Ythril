/**
 * Database-level test: `npm run links:convert` tells the truth about a space it could not convert (Q-274; bundle-53 G19).
 *
 * ## What it pins
 *
 * The script is the operator's way to convert a space whose boot conversion FAILED, which makes a failed space the case that matters
 * most to it. Three things were wrong when one existed.
 *
 * - **One space stopped the run.** `convertAllLinks` had no catch: a space that threw ended the loop with a stack trace, and every
 *   space after it was neither converted nor marked.
 * - **A partial walk was stamped anyway.** `stampFileMetaSeqs` ran for every report, a space with documents that did not reconcile
 *   included, so a space reported as failed had still had its file records given a `seq`.
 * - **The exit code was the only signal, and a thrown space did not set it honestly.** Now a failed space is NAMED, with its
 *   reason, the file seqs are not stamped for it and the line says so, and the exit code is non-zero, so a wrapper in a deploy step
 *   does not read a partial run as a clean one.
 *
 * ## How the failures are made, and why they are real
 *
 * The script is a CHILD PROCESS, so an in-process fault (`failWrites`) cannot reach it; both failures are faults of the stored data.
 *
 * - **A space that cannot be read** is a VIEW named like its facts collection, over a source document its pipeline cannot convert.
 * - **A document that cannot be reconciled** is a space whose LINKS collection is a view: a read of it works and every write to it
 *   fails, and the facts name a real entity, so the conversion has a link to write for each.
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/convert-links-cli-exits-nonzero-on-a-failed-space-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { runScript } from './_run-script.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-g19-cli-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'convert-links.mjs');

const BAD = 'g19clibad';
const SOFT = 'g19clisoft';
const GOOD = 'g19cligood';
const ENTITY = 'aaaaaaaa-0000-4000-8000-000000000020';
const AUTHOR = { instanceId: 'g19-cli', instanceLabel: 'test' };

let mongo;

const configure = (ids) => fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  instanceId: 'g19-cli', instanceLabel: 'test', tokens: [], networks: [],
  spaces: ids.map(id => ({ id, label: id, folders: [] })),
}, null, 2), { mode: 0o600 });

const configured = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).spaces;
const isMarked = (id) => configured().find(s => s.id === id)?.completeLinkage === true;
const run = (args = []) => runScript(SCRIPT, args, { env: { CONFIG_PATH } });

/** A space with one fact naming a real entity and one file record that has no `seq`, so there is something to stamp. */
async function seedSpace(id) {
  const db = mongo.getDb();
  await db.collection(`${id}_entities`).insertOne({ _id: ENTITY, spaceId: id, name: 'E', type: 'thing', tags: [], seq: 1 });
  await db.collection(`${id}_facts`).insertOne({ _id: `${id}-f`, spaceId: id, fact: 'a fact', type: '', tags: [], entityIds: [ENTITY], author: AUTHOR, seq: 2 });
  await db.collection(`${id}_files`).insertOne({ _id: `${id}/a.md`, spaceId: id, path: `${id}/a.md`, tags: [], author: AUTHOR });
}
const fileSeq = async (id) => (await mongo.getDb().collection(`${id}_files`).findOne({ _id: `${id}/a.md` }))?.seq;

describe('the links:convert script reports a failed space (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('g19cli');
    const db = mongo.getDb();
    await db.collection('g19cli_src').insertOne({ _id: 's1', a: 'not-a-number' });
    await db.createCollection(`${BAD}_facts`, { viewOn: 'g19cli_src', pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });
    await seedSpace(SOFT);
    await db.createCollection('g19cli_empty');
    await db.createCollection(`${SOFT}_links`, { viewOn: 'g19cli_empty' });
    await seedSpace(GOOD);
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('a run over a space it cannot read, a space whose documents do not reconcile, and a healthy one', () => {
    let result;
    before(() => {
      // The unreadable space is FIRST: a loop that stops at the first throw never reaches the others.
      configure([BAD, SOFT, GOOD]);
      result = run();
    });

    it('exits non-zero', () => {
      assert.equal(result.status, 1, result.out);
    });

    it('names both failed spaces with a reason, and does not print a stack trace for either', () => {
      assert.match(result.out, new RegExp(`${BAD}: FAILED`), result.out);
      assert.match(result.out, new RegExp(`${SOFT}: FAILED`), result.out);
      assert.match(result.out, /1 document\(s\) failed to reconcile/, result.out);
      assert.doesNotMatch(result.out, /\n\s+at \S+ \(/, `a stack trace reached the operator:\n${result.out}`);
    });

    it('converts and marks the healthy space after them, and marks neither failed space', async () => {
      assert.match(result.out, new RegExp(`${GOOD}: .*links added 1 .*failed 0`), result.out);
      assert.equal(isMarked(GOOD), true, 'the space after the failure was not marked');
      assert.equal(isMarked(BAD), false);
      assert.equal(isMarked(SOFT), false);
    });

    it('stamps the file seqs of the healthy space only, and the line says it did not for the others', async () => {
      assert.equal(typeof (await fileSeq(GOOD)), 'number', 'the healthy space\'s file record was not stamped');
      assert.equal(await fileSeq(SOFT), undefined, 'a space reported as failed had its file records stamped');
      assert.match(result.out, new RegExp(`${SOFT}: .*file seqs NOT stamped`), result.out);
      assert.match(result.out, new RegExp(`${BAD}: FAILED.*file seqs NOT stamped`), result.out);
    });
  });

  describe('naming one failed space', () => {
    it('exits non-zero, names it and its reason, and prints no stack trace', () => {
      configure([BAD]);
      const r = run([BAD]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`${BAD}: FAILED`), r.out);
      assert.doesNotMatch(r.out, /\n\s+at \S+ \(/, `a stack trace reached the operator:\n${r.out}`);
    });
  });

  describe('a clean run', () => {
    it('exits zero and stamps what it converted', async () => {
      const CLEAN = 'g19cliclean';
      await seedSpace(CLEAN);
      configure([CLEAN]);
      const r = run();
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`${CLEAN}: .*failed 0 .*file seqs stamped 1`), r.out);
      assert.equal(isMarked(CLEAN), true);
    });
  });
});
