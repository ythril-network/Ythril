/**
 * The contradiction scanner holds a type's position at the seed BEFORE one whose neighbour search ran over an index that was not
 * ready, on both of its cursors, and says so when the held scan is counted (Q-697, b235 design v3 items 8 and 9).
 *
 * ## The defect
 *
 * `evalRecord` drops the `degraded` that `findSimilar` answers. A seed whose search met a collection's vector index absent or still being
 * built got an EMPTY answer and was read as "no neighbours": the type's cursor moved past it (`scanOneSpace` advances after every seed
 * but a `judgeStalled` one, and writes the position after the batch), and the pairs it should have been judged against were never looked
 * at until a record of the pair was next edited. The duplicate scanner has held since Q-326 (`dupe-scanner.ts`); the contradiction
 * scanner, which has two cursors per type and the same search, had no hold at all, so the Review tab showed a clean queue over an index
 * that had not been asked.
 *
 * ## The rules
 *
 *  - a seed whose search answers `index_not_ready` ENDS its type for this run: the cursor stays at the seed BEFORE it (the held seed is
 *    not advanced past, and the position write that follows the batch is the one of the seed before it), and no pair is recorded for
 *    the held seed or any seed behind it. Both cursors hold on their own: the structured one (`{space}:{type}:contradiction`) and the
 *    NLI one (`...:nli`).
 *  - `index_unavailable` (an index that exists and refuses; waiting does not help) ADVANCES, as it does in the duplicate scanner: holding
 *    the cursor would stall the type until an operator acts. This passes on the base and guards the half that must not change.
 *  - `judge_stalled` (the NLI endpoint did not answer) keeps its own signal, `nliStalled`, and is NOT an index hold: it does not count
 *    toward `ythril_scan_holds_total`. Two causes, two signals; a counter that mixed them would send an operator to the index when the
 *    judge is down.
 *  - what a hold is counted as: `ythril_scan_holds_total{scanner}`, declared at zero, so a scrape before the first hold says 0.
 *
 * ## How it is observed
 *
 * The cursors are read from `ythril_dupe_scan_state`, the scanner's own store. The per-seed refusal is the real store's wording injected
 * at the read of ONE seed's search (`_mongot-refusals.mjs`, `forQuery`): the index of the space is real and serving, so every other seed
 * is answered by mongot, and the held seed is the only thing between the scan and its pair. Four facts, aged and vectored, scanned in
 * one batch: `f1` and `f2` have no neighbour, `f3` and `f4` are a pair whose `port` disagrees (a structured finding, found from either
 * side). With `f3` held the position must be `f2` and no pair may exist; on the base `f3` is passed over and `f4`, whose own search is
 * not refused, finds the pair from the other side while the cursor moves on to `f4`.
 *
 * "Seen red" on the base: the cursor of both passes is at `f4` and the pair is recorded; the counter is not declared.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-contradiction-scan-holds-its-position-while-the-index-is-not-ready-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, startStubEmbedder, queryAxis, createSpaceCollections, insertAll, waitUntilServing } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch, searchesWith } from './_mongot-refusals.mjs';
import { scanHoldSeries, scanHoldSum } from './_scan-holds.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

/** Two spaces, each indexed once: a pair that disagrees on a property (a structured finding) and a pair that does not (only a judge can decide it). */
const CONFLICT = 'cshold-conflict';
const PLAIN = 'cshold-plain';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-cshold-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour old: outside the fresh-write window, so the index is the only thing that could supply a neighbour. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();
/** A unit vector on one axis outside the plane `unitAt` uses: orthogonal to every other record, so it has no neighbour above any threshold. */
const axis = (k) => Object.assign(new Array(DIMS).fill(0), { [k]: 1 });
const VECTORS = { f1: axis(1), f2: axis(3), f3: unitAt(0, DIMS), f4: unitAt(5, DIMS) };
const IDS = Object.keys(VECTORS);
const fact = (space, id, i, properties) => ({
  _id: id, spaceId: space, fact: `fact ${id}`, tags: [], ...(properties ? { properties } : {}),
  embedding: VECTORS[id], embeddingModel: 'stub', seq: i + 1, pos: i + 1, posAtSeq: i + 1, createdAt: OLD, updatedAt: OLD,
});
const PORTS = { f3: 8080, f4: 9090 };

let mongo, scanner, registry, stub, judge;
/** What the stub judge answers: a verdict, or a failure the scanner reads as "the judge could not answer". */
let judgeMode = 'answers';

const cursor = (space, pass) => mongo.col('ythril_dupe_scan_state').findOne({ _id: `${space}:fact:contradiction${pass === 'nli' ? ':nli' : ''}` });
const candidates = (space) => mongo.col(`${space}_contradiction_candidates`).countDocuments({});

/** `ythril_scan_holds_total` as the scrape says it (`_scan-holds.mjs`): every series, or null when none is declared. */
const holdsTotal = () => scanHoldSeries(registry);
const sum = scanHoldSum;

describe('the contradiction scanner and an index that is not ready', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (judgeMode === 'fails') { res.writeHead(500); res.end('judge down'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ label: 'neutral', score: 0.95 }));
      });
    });
    judge = await listenOnLoopback(server);
    process.env['NLI_URL'] = judge.url;
    process.env['NLI_MODEL'] = 'stub-mnli';

    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'cshold', instanceLabel: 'test', tokens: [], networks: [], spaces: [CONFLICT, PLAIN].map(id => ({ id, label: id, folders: [] })) }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('cshold');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    loader.getConfig().contradictionScanner = { batchSize: 10, maxPerRun: 100 };
    scanner = await import('../../server/dist/brain/contradiction-scanner.js');
    registry = await import('../../server/dist/metrics/registry.js');
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    const vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    const available = await mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanner returns before reading anything, so every case would pass for no reason');
    for (const space of [CONFLICT, PLAIN]) {
      await createSpaceCollections(mongo, space);
      await raiseVersionTo(space, 100);
      await insertAll(mongo, `${space}_facts`, IDS.map((id, i) => fact(space, id, i, space === CONFLICT && PORTS[id] ? { port: PORTS[id] } : undefined)));
      // Production's own builder, so the live definition is production's: the index is REAL and serves, and the refusal below is the only fault.
      await vectorIndex.ensureVectorSearchIndex(space, 'facts', DIMS, 'cosine', 'embedding', 'embedding', true, []);
      await waitUntilServing(mongo, `${space}_facts`, `${space}_facts_embedding`, { dims: DIMS, n: IDS.length });
    }
  });

  after(async () => {
    delete process.env['NLI_URL'];
    delete process.env['NLI_MODEL'];
    await closeTestMongo();
    await stub?.close();
    await judge?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    judgeMode = 'answers';
    await mongo.col('ythril_dupe_scan_state').deleteMany({});
    for (const space of [CONFLICT, PLAIN]) await mongo.col(`${space}_contradiction_candidates`).deleteMany({});
  });

  it('a held seed in mid-batch leaves BOTH cursors at the seed before it, with no pair recorded for it', async () => {
    const before = sum(await holdsTotal());
    const fault = refuseVectorSearch(REFUSALS.notInitialized, { forQuery: searchesWith(VECTORS.f3) });
    let first;
    try { first = await scanner.scanSpace(CONFLICT); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 2, `the refusal reached ${fault.refused()} search(es), not one per pass: the case did not produce the state it is about`);
    for (const pass of ['structured', 'nli']) {
      const stored = await cursor(CONFLICT, pass);
      assert.equal(stored?.cursorPos?.id, 'f2',
        `the ${pass} cursor is at ${JSON.stringify(stored?.cursorPos)}: the seed whose search met an index that was not ready was passed over, `
        + `and its pairs (${first.scanned} record(s) scanned in all) are marked looked-at though they never were`);
      assert.equal(stored?.cursorSeq, 2, `the ${pass} cursor's position is not the position of the seed before the held one`);
    }
    assert.equal(await candidates(CONFLICT), 0,
      'a pair was recorded for the held seed or one behind it: the held seed ends the type, and the seeds after it are not asked');
    // Nothing is lost: once the index answers, the next run reads the held seed again and finds what it hid.
    const second = await scanner.scanSpace(CONFLICT);
    assert.ok(second.scanned > 0, 'the next run scanned nothing: the records the held run did not settle are lost to the scanner');
    assert.equal(await candidates(CONFLICT), 1, 'the pair the held seed hides was not found by the run after it');
    // One hold is counted per cursor that held, so the held run raised the counter by two (the label is the hold's scanner, whichever it is called).
    const after = await holdsTotal();
    assert.ok(after, 'ythril_scan_holds_total is not declared: a held scan is counted nowhere');
    assert.equal(sum(after) - before, 2, `the held run counted ${sum(after) - before} hold(s) for two cursors that held: ${JSON.stringify(after)}`);
  });

  it('a held seed holds the NLI cursor and the structured cursor on their own', async () => {
    // The structured pass holds alone while the NLI pass is not configured to run: the structured cursor is held, and no NLI cursor appears.
    const was = process.env['NLI_URL'];
    delete process.env['NLI_URL'];
    const fault = refuseVectorSearch(REFUSALS.notInitialized, { forQuery: searchesWith(VECTORS.f3) });
    try { await scanner.scanSpace(CONFLICT); } finally { fault.restore(); process.env['NLI_URL'] = was; }
    assert.ok(fault.refused() >= 1, 'the fault never reached a seed');
    assert.equal((await cursor(CONFLICT, 'structured'))?.cursorPos?.id, 'f2', 'the structured cursor did not hold on its own');
    assert.equal(await cursor(CONFLICT, 'nli'), null, 'an NLI cursor exists for a pass that did not run');
  });

  it('on index_unavailable the cursors advance past the refused seed (holding them would stall the type)', async () => {
    const fault = refuseVectorSearch(REFUSALS.dimensionMismatch, { forQuery: searchesWith(VECTORS.f3) });
    const before = sum(await holdsTotal());
    try { await scanner.scanSpace(CONFLICT); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 2, 'the fault never reached the refused seed in both passes');
    for (const pass of ['structured', 'nli']) {
      const stored = await cursor(CONFLICT, pass);
      assert.equal(stored?.cursorPos?.id, 'f4', `the ${pass} cursor is at ${JSON.stringify(stored?.cursorPos)}: an index that needs an operator must not hold the type for ever`);
    }
    assert.equal(sum(await holdsTotal()) - before, 0, 'an index_unavailable advance was counted as a hold');
  });

  it('judge_stalled keeps nliStalled and the NLI cursor where it was, and is not counted as an index hold', async () => {
    judgeMode = 'fails';
    const before = await holdsTotal();
    assert.ok(before, 'ythril_scan_holds_total is not declared: "not counted" would be true of a metric that does not exist');
    const result = await scanner.scanSpace(PLAIN);
    assert.equal(result.nliStalled, true, `the judge did not answer and the result does not say so: ${JSON.stringify(result)}`);
    const nli = await cursor(PLAIN, 'nli');
    assert.equal(nli?.cursorPos?.id, 'f2', `the NLI cursor is at ${JSON.stringify(nli?.cursorPos)}: a pair the judge could not decide was settled`);
    const structured = await cursor(PLAIN, 'structured');
    assert.equal(structured?.cursorPos?.id, 'f4', 'a stalled judge held the structured pass, which never reaches it');
    assert.deepEqual(await holdsTotal(), before, 'a stalled judge was counted as an index hold: ythril_scan_holds_total is the index\'s signal, nliStalled is the judge\'s');
  });
});
