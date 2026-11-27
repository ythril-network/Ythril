/**
 * The result record: one file per run, carrying everything a later reader needs to know which run it was
 * (design R10), written once and never over an earlier file.
 *
 * Run: node --test testing/standalone/bsbm-harness-result-record.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecord, recordFileName, writeRecord, END_MARKER } from '../../benchmarks/rdf/result-record.mjs';

function input(over = {}) {
  return {
    outcome: 'ok',
    engine: 'oxigraph',
    size: 1000,
    ythrilCommit: '2bfffd806',
    oxigraphDigest: 'sha256:' + 'a'.repeat(64),
    bsbmSeed: { generator: 53223436, driver: 808080 },
    dataset: { variant: 'ythril-loadable-1', triples: 371000, sha256: 'b'.repeat(64) },
    loadMs: 1234,
    valid: true,
    warmups: 3,
    runs: 20,
    queries: {
      Q1: { median: 2.5, p95: 4, n: 20, errors: 0 },
      Q2: { error: { code: 404, message: 'Not Found' }, n: 0, errors: 23 },
    },
    startedAt: '2026-11-25T00:45:00.000Z',
    ...over,
  };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'b271-record-'));
}

test('the record carries every design-R10 field and ends with the end marker', () => {
  const rec = buildRecord(input());
  for (const key of ['outcome', 'size', 'ythrilCommit', 'oxigraphDigest', 'bsbmSeed', 'queries', 'loadMs']) {
    assert.ok(key in rec, `missing ${key}`);
  }
  assert.equal(rec.queries.Q1.median, 2.5);
  assert.equal(rec.queries.Q1.p95, 4);
  assert.equal(Object.keys(rec).at(-1), 'end');
  assert.equal(rec.end, END_MARKER);
});

test('a record missing a required field is refused, naming the field', () => {
  for (const key of ['outcome', 'size', 'ythrilCommit', 'oxigraphDigest', 'bsbmSeed', 'queries', 'engine']) {
    const bad = input();
    delete bad[key];
    assert.throws(() => buildRecord(bad), new RegExp(key), `${key} must be required`);
  }
});

test('a record names the dataset variant it ran on and that variant\'s sha256, so two engines are known to have loaded the same bytes', () => {
  const rec = buildRecord(input());
  assert.deepEqual(rec.dataset, { variant: 'ythril-loadable-1', triples: 371000, sha256: 'b'.repeat(64) });
  const bad = (dataset) => () => buildRecord(input({ dataset }));
  assert.throws(bad(undefined), /dataset/);
  assert.throws(bad({ triples: 1, sha256: 'b'.repeat(64) }), /variant/);
  assert.throws(bad({ variant: 'v', triples: 1 }), /sha256/);
  assert.throws(bad({ variant: 'v', triples: 1, sha256: 'xyz' }), /sha256/);
  assert.throws(bad({ variant: 'v', sha256: 'b'.repeat(64) }), /triples/);
});

test('an unknown outcome and a query with neither timing nor error are refused', () => {
  assert.throws(() => buildRecord(input({ outcome: 'fine' })), /outcome/);
  assert.throws(() => buildRecord(input({ queries: { Q1: { n: 3 } } })), /Q1/);
});

test('a load that was refused is recorded with its code instead of a time', () => {
  const rec = buildRecord(input({ loadMs: null, loadRefusal: { code: 'rdf_bound_exceeded', status: 413 } }));
  assert.equal(rec.loadMs, null);
  assert.equal(rec.loadRefusal.code, 'rdf_bound_exceeded');
  assert.throws(() => buildRecord(input({ loadMs: null })), /loadMs|loadRefusal/);
});

test('the file name is the UTC stamp, the engine and the size', () => {
  assert.equal(recordFileName(new Date('2026-11-25T00:45:07.123Z'), 'oxigraph', 1000), '20261125T004507Z-oxigraph-1000.json');
});

test('writing creates the folder and a file that parses back to the record', () => {
  const dir = join(scratch(), 'nested', 'results');
  const rec = buildRecord(input());
  const path = writeRecord(dir, rec, new Date('2026-11-25T00:45:07Z'));
  assert.equal(path, join(dir, '20261125T004507Z-oxigraph-1000.json'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), rec);
  rmSync(join(dir, '..', '..'), { recursive: true, force: true });
});

test('a second write to the same name throws and leaves the earlier file as it was', () => {
  const dir = scratch();
  const when = new Date('2026-11-25T00:45:07Z');
  const first = writeRecord(dir, buildRecord(input()), when);
  const before = readFileSync(first, 'utf8');
  assert.throws(() => writeRecord(dir, buildRecord(input({ loadMs: 1 })), when), /exists|overwrite/i);
  assert.equal(readFileSync(first, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['20261125T004507Z-oxigraph-1000.json']);
  // A file that was there before the harness ran is protected the same way.
  const other = join(dir, '20261125T004508Z-oxigraph-1000.json');
  writeFileSync(other, 'keep me');
  assert.throws(() => writeRecord(dir, buildRecord(input()), new Date('2026-11-25T00:45:08Z')), /exists|overwrite/i);
  assert.equal(readFileSync(other, 'utf8'), 'keep me');
  rmSync(dir, { recursive: true, force: true });
});

const LIMITS = { timeoutMs: 300000, maxRecordsRead: 10000000, maxResults: 100000 };
// What a Ythril query carries beside the client's wall time: the door's total and the engine's own time per measured run, and their summaries.
const timing = (n = 20) => ({
  door: { median: 2, p95: 3 }, engine: { median: 1, p95: 2 },
  perRun: Array.from({ length: n }, () => ({ wallMs: 2.5, doorMs: 2, engineMs: 1 })),
});
const judged = {
  Q1: { median: 2.5, p95: 4, n: 20, errors: 0, ...timing(), comparable: true },
  Q2: { median: 9, p95: 12, n: 20, errors: 0, ...timing(), comparable: false, reason: 'data-not-held' },
};
const ythril = (over = {}) => input({ engine: 'ythril', sparqlLimits: LIMITS, queries: judged, ...over });

test('a Ythril record carries the three SPARQL limits it ran under, and the queue wait when it has one', () => {
  const rec = buildRecord(ythril({ embedQueue: { waitedMs: 5000, pending: 0, drained: true } }));
  assert.deepEqual(rec.sparqlLimits, LIMITS);
  assert.deepEqual(rec.embedQueue, { waitedMs: 5000, pending: 0, drained: true });
  assert.throws(() => buildRecord(input({ engine: 'ythril' })), /sparqlLimits/);
  for (const key of Object.keys(LIMITS)) {
    assert.throws(() => buildRecord(ythril({ sparqlLimits: { ...LIMITS, [key]: undefined } })), new RegExp(key), `${key} required`);
    assert.throws(() => buildRecord(ythril({ sparqlLimits: { ...LIMITS, [key]: 1.5 } })), new RegExp(key), `${key} whole number`);
  }
  assert.doesNotThrow(() => buildRecord(input()), 'an Oxigraph record has no SPARQL limits');
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { median: 2, p95: 3, n: 20, errors: 0 } } })), /Q1 has no comparable/);
});

test('a Ythril query carries the door\'s total and the engine\'s own time per measured run, so a comparison reads like for like', () => {
  const q = { median: 2.5, p95: 4, n: 20, errors: 0, comparable: true };
  const rec = buildRecord(ythril({ queries: { Q1: { ...q, ...timing() } } }));
  assert.deepEqual(rec.queries.Q1.door, { median: 2, p95: 3 });
  assert.deepEqual(rec.queries.Q1.engine, { median: 1, p95: 2 });
  assert.equal(rec.queries.Q1.perRun.length, 20);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: q } })), /Q1.*door/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...timing(), door: undefined } } })), /Q1.*door/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...timing(), engine: { median: 1 } } } })), /Q1.*engine/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...timing(), engine: { median: NaN, p95: 2 } } } })), /Q1.*engine/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...timing(), perRun: undefined } } })), /Q1.*perRun/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...timing(19) } } })), /Q1.*perRun/);
  const holed = timing(); holed.perRun[3] = { wallMs: 2, doorMs: 2 };
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, ...holed } } })), /Q1.*perRun/);
  // A query that only has an error has no times to carry; an Oxigraph record has no door.
  const failed = { error: { code: 404, message: 'Not Found' }, n: 0, errors: 23, comparable: true };
  assert.doesNotThrow(() => buildRecord(ythril({ queries: { Q1: failed } })));
  assert.doesNotThrow(() => buildRecord(input()));
});

test('a Ythril query is judged one by one: comparable, or one reason from the fixed list', () => {
  const q = { median: 2, p95: 3, n: 20, errors: 0, ...timing() };
  const rec = buildRecord(ythril({ queries: { Q1: { ...q, comparable: true }, Q2: { ...q, comparable: false, reason: 'data-not-held' } } }));
  assert.equal(rec.queries.Q2.reason, 'data-not-held');
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, comparable: false } } })), /Q1.*reason/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, comparable: false, reason: 'it is slow' } } })), /Q1.*reason/);
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, comparable: true, reason: 'rows-differ' } } })), /Q1/);
});

test('valid agrees with the queries: false exactly when one is rows-differ', () => {
  const q = { median: 2, p95: 3, n: 20, errors: 0, ...timing() };
  const differing = [{ query: 'Q1', oxigraph: 5, ythril: 6 }];
  const named = { Q1: { ...q, comparable: false, reason: 'system-statements' }, Q2: { ...q, comparable: false, reason: 'data-not-held' } };
  assert.doesNotThrow(() => buildRecord(ythril({ queries: named })));
  assert.throws(() => buildRecord(ythril({ queries: { Q1: { ...q, comparable: false, reason: 'rows-differ' } } })), /valid/);
  assert.doesNotThrow(() => buildRecord(ythril({ valid: false, invalidQueries: differing, queries: { Q1: { ...q, comparable: false, reason: 'rows-differ' } } })));
  assert.throws(() => buildRecord(ythril({ valid: false, invalidQueries: differing, queries: named })), /valid/);
});

test('a record says whether it is valid: a Ythril run whose row counts differ from Oxigraph\'s names the queries', () => {
  assert.equal(buildRecord(input()).valid, true);
  assert.throws(() => buildRecord(input({ valid: undefined })), /valid/);
  assert.throws(() => buildRecord(input({ valid: 'yes' })), /valid/);
  const differing = [{ query: 'Q1', oxigraph: 10, ythril: 0 }];
  const rowsDiffer = { comparable: false, reason: 'rows-differ' };
  const bad = buildRecord(ythril({
    valid: false, invalidQueries: differing,
    queries: { Q1: { median: 2.5, p95: 4, n: 20, errors: 0, ...timing(), ...rowsDiffer }, Q2: { error: { code: 404, message: 'Not Found' }, n: 0, errors: 23, ...rowsDiffer } },
  }));
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.invalidQueries, differing);
  assert.throws(() => buildRecord(input({ valid: false })), /invalidQueries/);
  assert.throws(() => buildRecord(input({ valid: false, invalidQueries: [] })), /invalidQueries/);
  assert.throws(() => buildRecord(input({ valid: true, invalidQueries: differing })), /invalidQueries/);
});
