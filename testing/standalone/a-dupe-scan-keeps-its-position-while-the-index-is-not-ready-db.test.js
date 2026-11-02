/**
 * The duplicate scanner holds a type's scan position while its index is not ready, and moves past a type whose index will not
 * serve (Q-326, bundle-72 DESIGN v3 item 6; vet A-S8, B-S10).
 *
 * ## The defect
 *
 * A seed whose `findSimilar` found the collection's vector index absent or still being built got an EMPTY answer, and the scanner
 * read "no duplicates" and moved the type's keyset cursor past it (`dupe-scanner.ts`: the cursor advances in `finally` and the
 * position is written after the batch). Every record scanned while the index was rebuilding (after an upgrade, after a container
 * recreate: 120 s and more) was therefore marked scanned and its duplicates never looked for, until the record was next edited.
 *
 * ## The rules
 *
 *  - on `index_not_ready` (the answer's `degraded` says the index is being built over records it should serve) the type's scan
 *    position is NOT written: the next run scans the same records again, once the index serves. Held back, not a per-record mark:
 *    the cursor is one position per type, so the type ends for this run, as a timeout ends it.
 *  - on `index_unavailable` (an index that exists and will not serve, so waiting does not help) the position ADVANCES: holding it
 *    would stall the type until an operator acts, with the scanner reading the same records every night. A throttled warning
 *    names it instead. This passes on the base (the refusal fails each seed, and the cursor moves past a failed seed); it guards
 *    the half of the rule that must not change.
 *
 * ## How it is observed
 *
 * The position is read from `ythril_dupe_scan_state`, the scanner's own store, never from a probe inside it. The refusals are the
 * real store's wordings injected at the read (`_mongot-refusals.mjs`): the three records are aged and vectored, so the refusal is
 * the only thing standing between the scan and a duplicate answer.
 *
 * "Seen red" on the base: the not-ready run writes its position past all three records, and the next run scans none of them.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-dupe-scan-keeps-its-position-while-the-index-is-not-ready-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, startStubEmbedder, queryAxis, createSpaceCollections } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';

const skip = await mongoSkipReason();

const S = 'dupepos';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-dupepos-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour old: outside the fresh-write window, so the index is the only thing that could supply a neighbour. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const IDS = ['e1', 'e2', 'e3'];
const entity = (id, i) => ({
  _id: id, spaceId: S, name: id, type: 'thing', tags: [], properties: {}, description: `record ${id}`,
  embedding: unitAt(10 * (i + 1), DIMS), embeddingModel: 'stub', seq: i + 1, pos: i + 1, posAtSeq: i + 1, createdAt: OLD, updatedAt: OLD,
});

let mongo, scanner, loader, stub;

const position = () => mongo.col('ythril_dupe_scan_state').findOne({ _id: `${S}:entity` });

describe('the duplicate scanner and an index that is not ready', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'dupepos', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: S, label: S, folders: [] }] }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('dupepos');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    scanner = await import('../../server/dist/brain/dupe-scanner.js');
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    const available = await mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanner returns before reading anything, so every case would pass for no reason');
    await createSpaceCollections(mongo, S);
    await raiseVersionTo(S, 100);
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    loader.getConfig().dupeScanner = { types: ['entity'], batchSize: 2, maxPerRun: 100 };
    await mongo.col('ythril_dupe_scan_state').deleteMany({});
    await mongo.col(`${S}_entities`).deleteMany({});
    await mongo.col(`${S}_entities`).insertMany(IDS.map(entity));
  });

  it('on index_not_ready the type\'s scan position is not written, and the next run scans the records again', async () => {
    const fault = refuseVectorSearch(REFUSALS.notInitialized);
    let first;
    try { first = await scanner.scanSpace(S); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 1, 'the fault never reached a seed - the case did not produce the state it is about');
    const stored = await position();
    assert.ok(!stored || !stored.cursorSeq,
      `the scan position was written (${JSON.stringify(stored?.cursorPos)}) though the index was not ready: ${first.scanned} record(s) are marked scanned `
      + 'and their duplicates were never looked for - the next run starts after them');
    const second = await scanner.scanSpace(S);
    assert.ok(second.scanned > 0, 'the next run scanned nothing: the records the not-ready run read are lost to the scanner');
  });

  it('on index_unavailable the position advances past the records (holding it would stall the type)', async () => {
    const fault = refuseVectorSearch(REFUSALS.dimensionMismatch);
    try { await scanner.scanSpace(S); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 1, 'the fault never reached a seed');
    const stored = await position();
    assert.equal(stored?.cursorSeq, IDS.length, `the position is ${JSON.stringify(stored?.cursorPos)}: an index that needs an operator must not hold the type for ever`);
    assert.equal(stored?.cursorPos?.id, IDS.at(-1));
  });
});
