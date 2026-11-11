/**
 * Every function that writes the bytes fields of a file row (`sizeBytes`, `sha256`) names the absent-bytes stamp in the same function, and the
 * one re-keying of a row drops it (bundle-70, Q-337, slice S4: the writers gate).
 *
 * ## What it prevents
 *
 * The absent-bytes sweep stamps a record whose bytes this disk lacks (`bytesAbsentSince`) and later removes it while the stamp is still the one
 * it wrote. A writer that puts bytes back and leaves the stamp makes a LIVE file read as a record that has waited a day for its bytes: the next
 * pass can retire it. `every-byte-writer-clears-the-absent-bytes-stamp-db` drives the doors known today; this gate holds the NEXT writer, which
 * no case names yet, to the same rule.
 *
 * ## How the set is derived
 *
 * From the call-graph index (`_call-graph.mjs`, comments stripped): a function that calls a write method (`updateOne`, `updateMany`,
 * `replaceOne`, `insertOne`, `insertMany`, `bulkWrite`, `findOneAndUpdate`, `findOneAndReplace`), names the files collection
 * (`spaceCollection(.., 'files')` or `col<FileMetaDoc>`) and names a bytes field. Each must name `BYTES_ABSENT_SINCE` (the field's one spelling,
 * `sync/local-only-fields.ts`) or carry a reasoned row here; a row whose function no longer matches fails, so the table cannot go stale. A floor
 * on the derived set fails a derivation that stopped matching.
 *
 * Red on f423dd6e: `BYTES_ABSENT_SINCE` does not exist, so neither `upsertFileMeta` nor `recordArrivedFile` names it.
 *
 * Run: node --test testing/standalone/every-writer-of-a-file-rows-bytes-clears-the-absent-bytes-stamp.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex } from './_call-graph.mjs';

const INDEX = moduleIndex('server/src');
const WRITES = /\.(updateOne|updateMany|replaceOne|insertOne|insertMany|bulkWrite|findOneAndUpdate|findOneAndReplace)\s*\(/;
const FILES = /spaceCollection\([^)]*'files'\)|col<FileMetaDoc>/;
const BYTES = /\b(sizeBytes|sha256)\b/;
const NAMES_STAMP = /\bBYTES_ABSENT_SINCE\b/;

/** Writers of a bytes field that put no bytes at a path, each with why. */
const EXEMPT = new Map([
  ['server/src/sync/file-sync.ts:recordSyncBase', 'writes `syncBase.<peer>`, the hash this instance and a peer last agreed on: a fact about the agreement, written after a pull whose own record write cleared the stamp'],
]);

const writers = () => [...INDEX.bodies].filter(([key, { body }]) => key.startsWith('server/src/') && WRITES.test(body) && FILES.test(body) && BYTES.test(body));

describe('every writer of a file row\'s bytes clears the absent-bytes stamp (source gate)', () => {
  it('the derivation finds the writers it must (a floor)', () => {
    const keys = writers().map(([k]) => k);
    for (const k of ['server/src/files/file-meta.ts:upsertFileMeta', 'server/src/files/file-meta.ts:recordArrivedFile']) {
      assert.ok(keys.includes(k), `the derivation no longer finds ${k}: re-anchor this gate (found ${keys.join(', ')})`);
    }
  });

  it('each names the stamp, or is exempt with its reason', () => {
    const offenders = writers().filter(([key, { body }]) => !NAMES_STAMP.test(body) && !EXEMPT.has(key)).map(([k]) => k);
    assert.deepEqual(offenders, [], 'these functions write a file row\'s bytes fields and never name BYTES_ABSENT_SINCE: a live file they write can keep a stamp and be retired by the absent-bytes sweep');
  });

  it('no exemption is stale', () => {
    const keys = new Set(writers().map(([k]) => k));
    const stale = [...EXEMPT.keys()].filter(k => !keys.has(k));
    assert.deepEqual(stale, [], 'an exempt writer no longer matches: remove its row');
  });

  it('a re-keyed row (a move, a legacy re-key) drops the stamp: rekeyedRow names it', () => {
    const body = INDEX.bodies.get('server/src/sync/local-only-fields.ts:rekeyedRow')?.body;
    assert.ok(body, 'rekeyedRow is not where this gate looks — re-anchor');
    assert.match(body, /delete\s+out\[\s*BYTES_ABSENT_SINCE\s*\]/, 'rekeyedRow carries the stamp of the old path to the new one');
  });
});
