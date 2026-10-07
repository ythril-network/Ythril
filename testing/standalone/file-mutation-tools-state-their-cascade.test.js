/**
 * The file-mutation tools say what happens BESIDES the obvious, and each claim is pinned to the code.
 *
 * ## What was missing
 *
 * Three one-line descriptions — *"Move or rename a file or directory"*, *"Delete a file from the space file
 * store"*, *"Create a directory (and any required parents)"* — each of which is true and none of which says
 * the thing a caller gets wrong.
 *
 * - **`delete_file` is a CASCADE and it is IDEMPOTENT.** It cancels queued media jobs, removes conversion
 *   artifacts, writes a sync tombstone and fires a webhook. And deleting a path that is not there SUCCEEDS —
 *   the opposite of every brain delete, all four of which error on an unknown id. A caller who reads a
 *   success as proof the file existed is wrong, and nothing said so.
 * - **`move_file` tombstones the old paths**, because sync has no rename detection: without it the peer's
 *   manifest pushes the original back and you have both copies. For a directory move that is every child
 *   path, and every child's metadata is re-rooted too — this tool used to rename only the record it was
 *   handed, orphaning the rest.
 * - **`create_dir` is mostly unnecessary.** `write_file` and `move_file` create their destination's parents
 *   themselves, so the tool is for the case where the EMPTY directory is the point — and an empty directory
 *   never reaches a peer, because only files sync.
 *
 * ## Every claim is checked against source
 *
 * Prose about a cascade is worth nothing if the cascade changes underneath it. Each assertion below names the
 * function that makes its sentence true, so removing the behaviour fails the description rather than quietly
 * outdating it.
 *
 * Run: node --test testing/standalone/file-mutation-tools-state-their-cascade.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockAfter } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const FILE_TOOLS = readFileSync('server/src/mcp/tools/file.ts', 'utf8');
// The cascade is two modules since bundle-51: the order and the tombstones are `delete-cascade.ts`'s, and what a file leaves
// once its bytes are gone (the job, the artefacts, the cached hash, the usage figure, the row) is `remove-file-here.ts`'s,
// shared with the media worker's reconcile and a peer's file tombstone. Read as one text, `delete-cascade.ts` first, so the
// order assertions below still compare positions in the order the steps run.
const CASCADE = stripComments(readFileSync('server/src/files/delete-cascade.ts', 'utf8')
  + '\n' + readFileSync('server/src/files/remove-file-here.ts', 'utf8'));
const FILES = stripComments(readFileSync('server/src/files/files.ts', 'utf8'));
// The file door (F-43): the rename and the parent-creation that `files.ts` used to do inline now happen here.
const DOOR = stripComments(readFileSync('server/src/files/stored-bytes.ts', 'utf8'));
const doorFn = (name) => { const at = DOOR.indexOf(`export async function ${name}`); return DOOR.slice(at, DOOR.indexOf('\nexport ', at + 10)); };
const FS_MODES = stripComments(readFileSync('server/src/util/fs-modes.ts', 'utf8'));

const description = (name) => {
  const s = stripComments(FILE_TOOLS);
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found — the scanner is wrong, not the code`);
  const d = s.indexOf('description:', at);
  const end = s.slice(d).search(/\n {2,}(mutating|spaceRequired|admin|spaceAdmin|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return s.slice(d, d + end);
};

const DELETE = description('delete_file');
const MOVE = description('move_file');
const MKDIR = description('create_dir');

describe('delete_file describes the cascade it really performs', () => {
  it('names the derived things that go with the blob', () => {
    for (const claim of [/tombstone/i, /job/i, /artifact/i, /webhook/i, /usage/i]) {
      assert.match(DELETE, claim, 'a caller deleting by other means needs to know what this cleans up');
    }
  });

  it('and each of those is really in the cascade', () => {
    // set-claim: the functions the delete cascade calls, pinned so the tool's PROSE cannot outlive them.
    // Both halves are literal on purpose: the case exists to compare a description against an implementation.
    // Pinned to the implementation: prose about a cascade is worthless if the cascade changed underneath it.
    for (const fn of ['writePendingFileTombstones', 'actUnderPendingTombstones', 'cancelMediaJob', 'deleteConversionArtifacts',
      'invalidateUsageCache', 'emitWebhookEvent']) {
      assert.match(CASCADE, new RegExp(`${fn}\\(`), `${fn} left the cascade — the description now overclaims`);
    }
  });

  /*
   * Rewritten by bundle-30 I13. This pinned "IT IS IDEMPOTENT … a path that is not there succeeds quietly" to a handler
   * shape, and the claim was false: the unlink threw ENOENT, so a missing path was an error carrying the absolute data
   * path, while the path parameter's own description said "is an error". The cascade now answers a missing path as
   * not found on every door, and an orphan (metadata, no bytes) is completed — so the description says that, and these
   * cases pin each sentence to the code that makes it true.
   */
  it('says a missing path is an error on every door, like the brain deletes, and a failed delete is safe to retry', () => {
    assert.match(DELETE, /NOT THERE IS AN ERROR/, 'a caller must be told a success means something was there');
    assert.match(DELETE, /delete_fact[^]*delete_chrono/, 'name the deletes that behave the same');
    assert.match(DELETE, /`404` on `DELETE \/api\/files\/:spaceId` and `POST \/api\/delete_file`/, 'say what each door answers');
    assert.match(DELETE, /COMPLETED/, 'an orphan (metadata, no bytes) is completed, not refused');
    assert.match(DELETE, /SAFE TO RETRY/, 'a store failure leaves the file, so the retry repeats the cascade');
    assert.doesNotMatch(DELETE, /IDEMPOTENT|succeeds\s+quietly/, 'the old, false claim is back');
  });

  it('and that is still true — the cascade refuses only what has neither bytes nor a live file record, after the tombstone order', () => {
    // The handler hands the path straight to the cascade, which decides; no second not-found check of its own.
    const handler = FILE_TOOLS.slice(FILE_TOOLS.indexOf("name: 'delete_file'"));
    const end = handler.indexOf('\nexport const ');
    assert.match(stripComments(end === -1 ? handler : handler.slice(0, end)), /await deleteFileCascade\([^)]*\);\s*return \{/,
      'delete_file decides something itself before the cascade — the description describes the cascade');
    const notFound = CASCADE.indexOf('throw new NotFoundError(');
    const tombstone = CASCADE.indexOf('writePendingFileTombstones(');
    // The unlink is `deleteStoredIfPresent` (bundle-51 round 4): the one deleter that reads a missing path as done and nothing
    // else as done, where the cascade used to spell that tolerance by hand around `deleteStored`.
    const unlink = CASCADE.indexOf('deleteStoredIfPresent(');
    assert.ok(notFound > -1, 'the cascade no longer answers a missing path as not found');
    assert.ok(notFound < tombstone && tombstone < unlink,
      'the cascade must refuse a path that is not there, then write the tombstone, then remove the bytes — in that order');
    assert.match(CASCADE.slice(CASCADE.lastIndexOf('if', notFound), notFound), /!\(await hasLiveFileRecordExactlyAt\(/,
      'the not-found refusal is no longer conditional on a LIVE file record at the path being absent too — an orphan would be refused, or a flagged one completed');
  });

  it('and says a flagged or derived record is not found too (Q-343)', () => {
    assert.match(DELETE, /flagged deleted[^]*derived record[^]*not found too/,
      'a retried delete of a flagged or derived record answers 404 — the description must say so');
  });
});

/*
 * What a delete removes, as the cascade's list stands since bundle-71 (Q-349): everything a file LEFT, however deep, and whatever
 * its sidecar's bytes became at a peer. Each sentence of `delete_file`'s description is pinned to the code that makes it true,
 * and the description says the GUARANTEE ("no peer restores the file or anything derived from it") rather than a mechanism a
 * later change would have to revisit.
 *
 * The cascade's pieces are read as one corpus: the order and the tombstones (`delete-cascade.ts`), the list of what a file leaves
 * (`remove-file-here.ts`) and the remover of its conversion's records (`converters/pipeline.ts`). Derived: the module that says
 * which sidecar paths belong to a path is the one that DEFINES `parentOfSidecar`, found in the tracked sources of `files/` and
 * not named here, so renaming it for the question it answers (the plan allows it) does not stale this gate.
 */
describe('delete_file removes what its conversion and its sidecars left, however deep (Q-349)', () => {
  const PIPELINE = stripComments(readFileSync('server/src/files/converters/pipeline.ts', 'utf8'));
  const REMOVER = `${CASCADE}\n${PIPELINE}`;
  const SIDECAR_MODULES = trackedSources(['server/src/files'], { ext: ['.ts'], floor: 20, specs: false, untracked: true })
    .filter(f => /\bexport\s+(?:async\s+)?(?:function|const)\s+parentOfSidecar\b/.test(stripComments(readFileSync(f, 'utf8'))));

  it('states the guarantee: no peer restores the file or anything derived from it', () => {
    assert.match(DELETE, /no peer restores the file or anything derived from it/i,
      'the description must promise the outcome a caller deleting a file cares about, not describe a mechanism');
  });

  it('removes the rows two levels down: the caption and face chunks of an extracted image are children of a sidecar, not of the file', () => {
    assert.match(REMOVER, /parentFileId:\s*\{\s*\$in\s*:/,
      'the remover reads only the rows whose parentFileId is the file itself; a row whose parent is one of the file\'s SIDECAR paths outlives it');
  });

  it('cancels the queued jobs of the extracted images, by the file\'s own path (the queue derives the trees a path owns)', () => {
    assert.match(PIPELINE, /cancelMediaJobsByPrefix\(spaceId,\s*originalId\)/,
      'a queued job of an extracted image retries for ever against a tree the delete removed; the cascade must hand the queue the file\'s own path, not spell the extraction tree itself');
    assert.doesNotMatch(PIPELINE, /cancelMediaJobsByPrefix\([^)]*_extracted\//,
      'the extraction tree\'s name is the queue\'s to derive (sidecarsOf); a literal here is the second copy of that rule');
  });

  it('one module answers which sidecar paths belong to a path (and the inverse), and the cascade reads it', () => {
    assert.equal(SIDECAR_MODULES.length, 1, `exactly one tracked module under files/ must export parentOfSidecar (found ${SIDECAR_MODULES.length}): the rule has one home`);
    const base = SIDECAR_MODULES[0].split('/').pop().replace(/\.ts$/, '');
    const importsIt = new RegExp(`from\\s+'\\.{1,2}/(?:[\\w-]+/)*${base}\\.js'`);
    assert.match(REMOVER, importsIt,
      `the cascade does not import ${base}: it removes the sidecars by a list of its own, the second copy of "which sidecar paths belong to a path"`);
  });
});

describe('move_file explains the tombstone and the directory case', () => {
  it('says the OLD paths are tombstoned, and why', () => {
    assert.match(MOVE, /TOMBSTONED/, 'name it');
    assert.match(MOVE, /rename detection/i,
      'the reason is the interesting part: sync cannot tell a move from a delete-plus-create');
  });

  it('says a directory move carries every child\'s metadata', () => {
    // The defect that was fixed and would otherwise be invisible: child records orphaned at paths with no
    // files.
    assert.match(MOVE, /DIRECTORY MOVE CARRIES EVERY CHILD/,
      'a caller moving a tree needs to know its tags survive');
  });

  it('warns that nothing checks the destination', () => {
    assert.match(MOVE, /NOTHING CHECKS THE DESTINATION FIRST/,
      'a move onto an existing path is a filesystem rename, and there is no refusal to catch it');
  });

  it('and that really is the case — moveFile renames with no existence check', () => {
    const at = FILES.indexOf('export async function moveFile');
    const body = FILES.slice(at, FILES.indexOf('\nexport ', at + 10));
    assert.match(body, /moveStored\(srcAbs, dstAbs\)/, 'moveFile no longer moves through the file door');
    const door = doorFn('moveStored');
    assert.match(door, /fsp\.rename\(srcAbs, dstAbs\)/, 'the door\'s move is no longer a bare rename');
    for (const b of [body, door]) {
      assert.doesNotMatch(b, /fileExists|already exists|\.stat\(dstAbs/,
        'a destination check appeared — delete the warning rather than leaving it wrong');
    }
  });

  it('says the content is not re-read, so a failed extraction stays failed', () => {
    assert.match(MOVE, /NOT RE-READ/, 'moving is not a repair, and retry_embedding is the tool that is');
  });
});

describe('create_dir says when you do not need it', () => {
  it('points out that write_file and move_file make their own parents', () => {
    assert.match(MKDIR, /write_file/, 'most callers should skip this step entirely');
  });

  it('and they really do', () => {
    const bodyOfFile = (fn) => { const at = FILES.indexOf(`export async function ${fn}`); return FILES.slice(at, FILES.indexOf('\nexport ', at + 10)); };
    assert.match(bodyOfFile('moveFile'), /mkdirPrivate\(path\.dirname\(/, 'moveFile no longer creates its parents');
    // writeFile hands its parents to the door, whose every write creates them unless the caller opts out.
    const write = bodyOfFile('writeFile');
    assert.match(write, /writeStored\(abs, content\)/, 'writeFile no longer writes through the file door');
    assert.doesNotMatch(write, /noMkdir/, 'writeFile opted out of creating its parents');
    const at = DOOR.indexOf('async function finishWrite');
    const finish = DOOR.slice(at, DOOR.indexOf('\n}', at));
    assert.match(finish, /if \(!opts\.noMkdir\) await mkdirPrivate\(path\.dirname\(abs\)\)/,
      'the file door no longer creates a write\'s parents');
  });

  it('says creating an existing directory succeeds', () => {
    assert.match(MKDIR, /SUCCEEDS rather than erroring/, 'safe to call blind is worth stating');
    assert.match(FS_MODES, /mkdir\(dir, \{ recursive: true/, 'which is only true while mkdir is recursive');
  });

  it('says an empty directory never reaches a peer', () => {
    assert.match(MKDIR, /NOT A SYNCED OBJECT/, 'only files sync');
  });

  it('and the sync-facing walk really pushes files only', () => {
    // `listFilesRecursive` descends into directories but pushes only `isFile()` entries, which is what makes
    // "an empty directory does not sync" true rather than plausible.
    const at = FILES.indexOf('export async function listFilesRecursive');
    const body = FILES.slice(at, FILES.indexOf('\nexport ', at + 10));
    // TWO WINDOWS, converted: each subject is a BRANCH of the same if/else, bounded by its own brace. The caps
    // could not tell "the push is in the isFile arm" from "the push is 80 characters later" — and if it moved
    // into the isDirectory arm the walk would emit directories, which is the exact claim above.
    const dir = body.indexOf('entry.isDirectory()');
    const file = body.indexOf('entry.isFile()');
    assert.ok(dir > -1 && file > -1, 'the walk no longer branches on entry type — re-anchor this gate');
    assert.match(blockAfter(body, dir, 'the isDirectory arm'), /walk\(full\)/, 'it descends');
    assert.match(blockAfter(body, file, 'the isFile arm'), /out\.push/, 'but only files are emitted');
  });
});
