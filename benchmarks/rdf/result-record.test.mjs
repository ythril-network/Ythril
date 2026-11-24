/**
 * The result record: one file per run, carrying everything a later reader needs to know which run it was
 * (design R10), written once and never over an earlier file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecord, recordFileName, writeRecord, END_MARKER } from './result-record.mjs';

function input(over = {}) {
  return {
    outcome: 'ok',
    engine: 'oxigraph',
    size: 1000,
    ythrilCommit: '2bfffd806',
    oxigraphDigest: 'sha256:' + 'a'.repeat(64),
    bsbmSeed: { generator: 53223436, driver: 808080 },
    loadMs: 1234,
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
