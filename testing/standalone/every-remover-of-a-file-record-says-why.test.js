/**
 * Every function that removes a file record (`removeFileHere`, `removeOneStoredFileHere`, `retireFileMeta`, `retireFileMetaMany`,
 * `retireFileMetaUnder`) is in one reason table, and ONE of them removes a record because its bytes are gone: the absent-bytes sweep
 * (bundle-70, Q-337, slice S4: the remover gate).
 *
 * ## What it prevents
 *
 * A path with no bytes is not always a deleted file: bytes still arriving from a peer, a record a restore brought back, a move carrying it, a
 * volume not mounted. The media worker used to remove a record whose source it could not find, with none of the sweep's window, holds or
 * evidence, so a record that only looked orphaned went with no way back. The rule: a record goes because a person or a peer deleted the file, a
 * move or a re-key carried it, a sidecar went with its file, or the absent-bytes sweep judged it due; and the last reason has ONE remover. A
 * new caller of a remover must say which reason it is, here, and a second "its bytes are gone" remover fails.
 *
 * ## How the set is derived
 *
 * From the call-graph index (`_call-graph.mjs`, comments stripped): every top-level function under `server/src` whose body calls one of the
 * removers, other than the removers' own definitions calling each other. A row whose function no longer calls one fails (stale); a floor fails
 * a derivation that stopped matching.
 *
 * Red on f423dd6e: the media worker's `reconcileDeletedSource` calls `removeFileHere` (a second remover of records whose bytes are gone), and
 * the sweep does not exist.
 *
 * Run: node --test testing/standalone/every-remover-of-a-file-record-says-why.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex } from './_call-graph.mjs';

const INDEX = moduleIndex('server/src');
const REMOVERS = /\b(?:removeFileHere|removeOneStoredFileHere|retireFileMeta|retireFileMetaMany|retireFileMetaUnder)\s*\(/;
/** The removers' own definitions, which call each other. */
const DEFINITIONS = new Set([
  'server/src/files/remove-file-here.ts:removeFileHere',
  'server/src/files/remove-file-here.ts:removeOneStoredFileHere',
  'server/src/files/file-meta.ts:retireFileMeta',
  'server/src/files/file-meta.ts:retireFileMetaMany',
  'server/src/files/file-meta.ts:retireFileMetaUnder',
]);

const BYTES_GONE = 'bytes-gone';
/** Every caller, with the reason its record goes. `bytes-gone` may have one row. */
const REASONS = new Map([
  ['server/src/files/delete-cascade.ts:deleteFileCascade', 'delete: a person deleted the file (REST, MCP); it keeps its tombstone'],
  ['server/src/files/delete-cascade.ts:retireRowsUnderDirectory', 'delete: a person deleted the folder'],
  ['server/src/files/delete-cascade.ts:removeWhatAMovedFileLeftAtItsSource', 'move: the record a finished move left at its source'],
  ['server/src/files/peer-tombstone-apply.ts:applyPeerFileTombstones', 'peer delete: a peer\'s tombstone this instance accepted'],
  ['server/src/sync/peer-sidecar-retirement.ts:retireInSpace', 'sidecar: a peer\'s sidecar copy retired with the file it was made from'],
  ['server/src/files/converters/pipeline.ts:removeSidecarRows', 'sidecar: rows an arrived sidecar made, retired with its file'],
  ['server/src/files/another-spelling-of-the-entry.ts:removeOnlyTheRecordNamed', 'peer delete: a peer\'s delete of one spelling whose bytes another record stands on'],
  ['server/src/files/absent-bytes-sweep.ts:removeDue', BYTES_GONE],
]);

const callers = () => [...INDEX.bodies].filter(([key, { body }]) => key.startsWith('server/src/') && !DEFINITIONS.has(key) && REMOVERS.test(body)).map(([k]) => k);

describe('every remover of a file record says why, and one removes for missing bytes (source gate)', () => {
  it('the derivation finds the callers (a floor)', () => {
    assert.ok(callers().length >= 6, `only ${callers().length} caller(s) derived: ${callers().join(', ')}`);
  });

  it('every caller is in the reason table', () => {
    const missing = callers().filter(k => !REASONS.has(k));
    assert.deepEqual(missing, [], 'these functions remove file records with no reason in the table: say which (a delete, a move, a peer\'s delete, a sidecar, the absent-bytes sweep)');
  });

  it('no row is stale', () => {
    const found = new Set(callers());
    assert.deepEqual([...REASONS.keys()].filter(k => !found.has(k)), [], 'a reason row names a function that no longer removes records: remove it');
  });

  it('exactly one remover removes a record because its bytes are gone, and it is the absent-bytes sweep', () => {
    const gone = [...REASONS].filter(([, why]) => why === BYTES_GONE).map(([k]) => k);
    assert.deepEqual(gone, ['server/src/files/absent-bytes-sweep.ts:removeDue']);
    assert.ok(!callers().some(k => k.startsWith('server/src/files/media/')), 'the media worker removes a record whose source it cannot find: that is the sweep\'s, after its window and holds');
  });
});
