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
import { blockAfter, enclosingBlocksMatching, statementAround } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { moveCascadeAsksDestinationFirst, guardPrecedesIrreversibleSteps, MOVE_CASCADE_STEPS } from './_cascade-order.mjs';

const FILE_TOOLS = readFileSync('server/src/mcp/tools/file.ts', 'utf8');
// The cascade is two modules since bundle-51: the order and the tombstones are `delete-cascade.ts`'s, and what a file leaves
// once its bytes are gone (the job, the artefacts, the cached hash, the usage figure, the row) is `remove-file-here.ts`'s,
// shared with the media worker's reconcile and a peer's file tombstone. Read as one text, `delete-cascade.ts` first, so the
// order assertions below still compare positions in the order the steps run.
// LF throughout: the bodies below end at a closing brace on its own line, which a CRLF checkout spells differently.
const CASCADE = stripComments(readFileSync('server/src/files/delete-cascade.ts', 'utf8')
  + '\n' + readFileSync('server/src/files/remove-file-here.ts', 'utf8')).replace(/\r\n/g, '\n');
const FILES = stripComments(readFileSync('server/src/files/files.ts', 'utf8'));
// The file door (F-43): the rename and the parent-creation that `files.ts` used to do inline now happen here.
const DOOR = stripComments(readFileSync('server/src/files/stored-bytes.ts', 'utf8'));
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

/** A description's sentences: its source-string joins closed, split after a full stop or at a `\n`. Read by SENTENCE so two halves of a guarantee cannot be met by two unrelated sentences. */
const sentencesOf = (text) => text.replace(/'\s*\r?\n\s*\+\s*'/g, '').split(/(?<=[.!?])\s+|\\n/);
/** The source text of one tool: from its `name:` to the next tool's, comments stripped. */
const toolSource = (name) => {
  const s = stripComments(FILE_TOOLS);
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found — the scanner is wrong, not the code`);
  const next = s.indexOf('\nexport const ', at);
  return s.slice(at, next === -1 ? undefined : next);
};
/** What a tool's handler does: its source from `async handle` on. */
const handlerOf = (name) => {
  const src = toolSource(name);
  const at = src.indexOf('async handle');
  assert.ok(at > 0, `${name} has no handler — the scanner is wrong, not the code`);
  return src.slice(at);
};

describe('delete_file describes the cascade it really performs', () => {
  it('names the derived things that go with the blob', () => {
    for (const claim of [/tombstone/i, /job/i, /artifact/i, /webhook/i, /usage/i, /\blinks?\b/i]) {
      assert.match(DELETE, claim, 'a caller deleting by other means needs to know what this cleans up');
    }
  });

  it('and each of those is really in the cascade', () => {
    // set-claim: the functions the delete cascade calls, pinned so the tool's PROSE cannot outlive them.
    // Both halves are literal on purpose: the case exists to compare a description against an implementation.
    // Pinned to the implementation: prose about a cascade is worthless if the cascade changed underneath it.
    for (const fn of ['writePendingFileTombstones', 'actUnderPendingTombstones', 'cancelMediaJob', 'deleteConversionArtifacts',
      'invalidateUsageCache', 'emitWebhookEvent', 'removeLinksOfDeletedFiles']) {
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
    // The handler hands the path and `confirm` straight to `deletePath`, which decides file, directory or refusal; no decision of
    // its own, so the doors cannot differ in what a path is (Q-438). Nothing in it names a cascade, a stat or the root.
    const handler = handlerOf('delete_file');
    assert.match(handler, /await deletePath\(\s*wt\.target\s*,\s*filePath\s*,\s*\{\s*confirm:\s*a\['confirm'\]\s*,\s*actor:\s*ctx\.actor\s*\}\s*\)/,
      'delete_file does not hand the path, `confirm` and the actor to deletePath as REST does — the doors would decide differently');
    assert.doesNotMatch(handler, /deleteFileCascade|deleteDirectoryCascade|NotFoundError|\.stat\(|spaceRoot|confirm\s*(?:===|!==|\?)|\bif\s*\(\s*!?confirm/,
      'delete_file decides something itself before or after deletePath — the description describes the one decision');
    // The cascade: read from the body of `deleteFileCascade`, where the order lives.
    const at = CASCADE.indexOf('export async function deleteFileCascade');
    assert.ok(at > -1, 'deleteFileCascade is no longer in delete-cascade.ts — re-anchor this gate');
    const cascade = CASCADE.slice(at, CASCADE.indexOf('\nexport ', at + 10));
    const notFound = cascade.indexOf('throw fileNotFound(');
    const tombstone = cascade.indexOf('writePendingFileTombstones(');
    // The unlink is `deleteStoredIfPresent` (bundle-51 round 4): the one deleter that reads a missing path as done and nothing
    // else as done, where the cascade used to spell that tolerance by hand around `deleteStored`.
    const unlink = cascade.indexOf('deleteStoredIfPresent(');
    assert.ok(notFound > -1, 'the cascade no longer answers a missing path as not found');
    assert.ok(notFound < tombstone && tombstone < unlink,
      'the cascade must refuse a path that is not there, then write the tombstone, then remove the bytes — in that order');
    assert.match(cascade.slice(cascade.lastIndexOf('if', notFound), notFound), /!\(await hasLiveFileRecordExactlyAt\(/,
      'the not-found refusal is no longer conditional on a LIVE file record at the path being absent too — an orphan would be refused, or a flagged one completed');
  });

  it('removes the links of what it deleted after the bytes and before the row, calling the remover directly so its failure fails the delete (Q-464)', () => {
    const body = (fn) => {
      const exported = CASCADE.indexOf(`export async function ${fn}`);
      const at = exported > -1 ? exported : CASCADE.indexOf(`\nasync function ${fn}`);
      assert.ok(at > -1, `${fn} is no longer in delete-cascade.ts — re-anchor this gate`);
      return CASCADE.slice(at, CASCADE.indexOf('\n}\n', at));
    };
    /** Every call of the link remover in `text`, as its offset and whether it is the second pass (bounded by `createdUntil`). */
    const callsOfLinkRemover = (text) => [...text.matchAll(/(?<![.\w$])removeLinksOfDeletedFiles\(/g)].map(m => {
      const statement = statementAround(text, m.index, 'the link remover\'s statement');
      return { at: m.index, secondPass: /createdUntil/.test(statement) };
    });
    const file = body('deleteFileCascade');
    const bytes = file.indexOf('deleteStoredIfPresent(');
    const row = file.indexOf('removeFileHere(');
    const dir = body('deleteDirectoryCascade');
    const tree = dir.indexOf('removeTree(');
    const rows = dir.indexOf('retireRowsUnderDirectory(');
    assert.ok(bytes > -1 && row > -1, `a file's delete must remove the bytes and the row (deleteStoredIfPresent ${bytes}, removeFileHere ${row})`);
    assert.ok(tree > -1 && rows > -1, `a directory delete must remove the tree and the rows (removeTree ${tree}, retireRowsUnderDirectory ${rows})`);
    // EVERY call of the link remover in the cascades — never the first alone: the first pass stands after the bytes and before the row (the
    // row is last because it is what tells a retry the delete is still owed), the second pass (`createdUntil`) after the row, and each is
    // awaited directly and sits in no try or catch (a failure in it fails the delete, it is never logged and survived).
    for (const [where, text, first, last] of [['deleteFileCascade', file, bytes, row], ['deleteDirectoryCascade', dir, tree, rows]]) {
      const calls = callsOfLinkRemover(text);
      assert.deepEqual(calls.map(c => c.secondPass), [false, true], `${where} must call the link remover twice: once before the row and once, bounded by createdUntil, after it (found ${calls.length} calls)`);
      for (const { at, secondPass } of calls) {
        assert.ok(secondPass ? at > last : (at > first && at < last),
          `${where}: the ${secondPass ? 'second' : 'first'} link pass stands ${secondPass ? 'before' : 'outside bytes-then-row'}: it must run ${secondPass ? 'after the row' : 'after the bytes and before the row'}`);
        // The statement the call sits in is the call itself, awaited: wrapped in a step that survives a failure it would be `unlessTheStoreFailed(…)` or `.catch(…)`.
        const statement = statementAround(text, at, `${where}: the link remover's statement`);
        assert.match(statement.trimStart(), /^await\s+removeLinksOfDeletedFiles\(/,`${where} does not await the link remover directly: a failure in it must fail the delete, never be logged and survived — ${statement.slice(0, 120)}`);
        assert.deepEqual(enclosingBlocksMatching(text, at, /\b(?:try|catch)\b[^{]*\{$/, `${where}: blocks around the link remover`), [],
          `${where} calls the link remover inside a try or a catch: the delete would answer done with the links left`);
      }
    }
    // The delete of a path a move carried a file to takes the source's links too, as the cascades do: awaited directly, in no try or catch.
    const carried = body('removeWhatAMovedFileLeftAtItsSource');
    const carriedCalls = callsOfLinkRemover(carried);
    assert.ok(carriedCalls.length >= 2, `removeWhatAMovedFileLeftAtItsSource calls the link remover ${carriedCalls.length} times: a kind of move source went without it`);
    for (const { at } of carriedCalls) {
      assert.match(statementAround(carried, at, 'the moved source\'s link remover statement').trimStart(), /^await\s+removeLinksOfDeletedFiles\(/, 'a moved source\'s link remover is not awaited directly');
      assert.deepEqual(enclosingBlocksMatching(carried, at, /\b(?:try|catch)\b[^{]*\{$/, 'blocks around the moved source\'s link remover'), [], 'a moved source\'s link remover sits in a try or a catch');
    }
  });

  // The guarantees a caller picks the tool by, as sentences (never a mechanism): which path it removes and what stops it. Q-438: the
  // tool said "not the tool for removing a directory tree" while the REST route of the same capability removed one.
  it('states that it deletes one file or, with confirm: true, a whole directory tree, and what refuses', () => {
    const says = (...parts) => sentencesOf(DELETE).find(s => parts.every(p => p.test(s)));
    assert.ok(says(/directory/i, /`confirm`/, /`true`/), 'no sentence says a directory is deleted with `confirm: true`');
    assert.ok(says(/without `confirm`/i, /directory/i, /`422`/, /nothing is deleted/i), 'no sentence says a directory without `confirm` is refused with 422 and nothing deleted');
    assert.ok(says(/space root/i, /never deleted/i, /`400`/), 'no sentence says the space root is never deleted (400)');
    assert.ok(says(/directory delete/i, /every file under it/i, /tombstone/i), 'no sentence says what a directory delete removes and tells peers');
    assert.ok(says(/repeating the call with `confirm: true`/i), 'no sentence says an interrupted directory delete is completed by repeating the call with `confirm: true`');
    assert.doesNotMatch(DELETE, /not the tool for removing a directory/i, 'the old refusal of directories is back in the description');
    assert.doesNotMatch(DELETE, /One FILE:/, 'the parameter list still says the path is one file');
  });

  // Q-469: a directory delete announces each file it removed. The sentence that scoped the webhook to a single file, because a directory
  // delete emitted none, was true until bundle-113 and is the claim this rewrites; each half is pinned to the code that makes it true.
  it('says a directory delete fires one file.deleted per file it removed — not only for a single file (Q-469)', () => {
    const about = sentencesOf(DELETE).filter(s => /file\.deleted/.test(s));
    assert.ok(about.length > 0, 'the description no longer says when the file.deleted webhook fires');
    assert.ok(about.some(s => /directory/i.test(s) && /\b(?:each|every|per)\b|one `?file\.deleted`? per/i.test(s)),
      `no sentence says a directory delete fires a file.deleted for each file it removed: ${about.join(' | ')}`);
    assert.doesNotMatch(DELETE, /fires for a single file|webhook\s+fires\s+for\s+(?:a\s+)?single\s+file|directory delete[^.]*(?:emits|fires) no\b/i,
      'the old claim that only a single file is announced is still in the description');
  });

  it('and that is what the code does: the directory delete is handed the actor and announces a file.deleted per row it retires, none without an actor (Q-469)', () => {
    const at = CASCADE.indexOf('export async function deleteDirectoryCascade');
    assert.ok(at > -1, 'deleteDirectoryCascade is no longer in delete-cascade.ts — re-anchor this gate');
    const header = CASCADE.slice(at, CASCADE.indexOf('{', at));
    assert.match(header, /actor\s*\??:\s*WebhookActor/, 'deleteDirectoryCascade takes no actor: it cannot announce what it removed');
    const path = CASCADE.indexOf('export async function deletePath');
    const pathBody = CASCADE.slice(path, CASCADE.indexOf('\n}\n', path));
    assert.match(pathBody, /deleteDirectoryCascade\(\s*spaceId\s*,\s*filePath\s*,\s*actor\s*\)/,
      'deletePath does not hand the actor to the directory delete: the doors announce nothing');
    // The whole directory delete, the helpers it names included: the announcement is gated on the actor, and is a file.deleted per path.
    const rest = CASCADE.slice(at);
    assert.match(rest, /if\s*\(\s*actor\s*\)[^;]*emitWebhookEvent\(\s*\{\s*event:\s*'file\.deleted'|if\s*\(\s*actor\s*\)\s*\{[^}]*emitWebhookEvent\(\s*\{\s*event:\s*'file\.deleted'/,
      'the directory delete does not announce a file.deleted gated on the actor (the brain family\'s one rule: no actor, no announcement)');
  });

  it('declares `confirm` as a described boolean parameter of the tool', () => {
    const schema = toolSource('delete_file');
    const at = schema.indexOf('confirm: {');
    assert.ok(at > -1, 'delete_file has no `confirm` parameter — a caller cannot delete a directory, and the REST twin can');
    const decl = schema.slice(at, schema.indexOf('}', at));
    assert.match(decl, /type:\s*'boolean'/, '`confirm` is not a boolean');
    assert.match(decl, /description:[^}]*(?:directory)/i, '`confirm` says nothing about what it is for');
    assert.match(decl, /Ignored for a file/i, '`confirm` does not say a file is unaffected by it');
  });

  it('and the one decision exists: deletePath is what REST, MCP and the tools door call', () => {
    const rest = stripComments(readFileSync('server/src/api/files.ts', 'utf8'));
    const at = rest.indexOf("fileStoreRouter.delete('/:spaceId'");
    assert.ok(at > -1, 'the REST DELETE route moved — re-anchor this gate');
    const route = rest.slice(at, rest.indexOf('\nfileStoreRouter.', at + 10));
    assert.match(route, /await deletePath\(/, 'REST DELETE does not call deletePath');
    assert.doesNotMatch(route, /deleteFileCascade|deleteDirectoryCascade|isUnfinishedDirectoryDelete|spaceRoot\(/,
      'REST DELETE decides file, directory or root itself: the second implementation of the rule deletePath holds');
    assert.match(CASCADE, /export async function deletePath\b/, 'delete-cascade.ts no longer exports deletePath');
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
  // The row half of the remover is shared (`deleteRowsDerivedFrom`, `files/derived-rows.ts`) with a peer's record-only removal.
  const REMOVER = `${CASCADE}\n${PIPELINE}\n${stripComments(readFileSync('server/src/files/derived-rows.ts', 'utf8'))}`;
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
    assert.match(PIPELINE, /cancelJobsOwnedBy\(spaceId,\s*originalId,\s*'file'\)/,
      'a queued job of an extracted image retries for ever against a tree the delete removed; the cascade must hand the queue the file\'s own path, not spell the extraction tree itself');
    assert.doesNotMatch(PIPELINE, /cancelJobsOwnedBy\([^)]*_(?:extracted|converted)\//,
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

  // The two guarantees a caller picks a destination by. Stated as GUARANTEES, never as a mechanism ("nothing checks", "a bare
  // rename"): the sentence that named the mechanism went stale the day a destination check was added, and nobody reports a
  // refusal they were told did not exist. Read by SENTENCE, so the two halves cannot be satisfied by two unrelated sentences.
  const SENTENCES = MOVE.replace(/'\s*\r?\n\s*\+\s*'/g, '').split(/(?<=[.!?])\s+|\\n/);
  const sentenceAbout = (...parts) => SENTENCES.find(s => parts.every(p => p.test(s)));

  it('states, as a guarantee, that a name blocked by a file is refused', () => {
    assert.ok(sentenceAbout(/blocked by a file/i, /refus/i),
      'no sentence says that a destination blocked by a file (`a.txt/x` where `a.txt` is a file, or a directory moved into itself) is REFUSED — '
      + 'the one thing a caller cannot find out from list_dir, and now a refusal rather than the filesystem\'s own failure');
  });

  // Q-437 (D-29): a move never replaces anything. The guarantee is stated with its code and its remedy, because a caller who is
  // refused needs both, and with what is NOT a taken name, because a caller who reads "refused" for every audit record would
  // never reuse a deleted file's name.
  it('states, as a guarantee, that a move never replaces anything: a file, a folder or a file\'s record at the destination is refused 409 destination_exists', () => {
    assert.ok(sentenceAbout(/never replaces/i), 'no sentence says a move never replaces anything');
    assert.ok(sentenceAbout(/\bfile\b/i, /\bfolder\b|\bdirectory\b/i, /record/i, /`409`/, /destination_exists/, /nothing changes/i),
      'no sentence says that a file, a folder or a file\'s record standing at `dst` is refused with 409 and destination_exists and that nothing changes');
    assert.ok(sentenceAbout(/delete the destination first/i, /delete_file/, /every instance/i),
      'no sentence names the remedy: delete the destination first with delete_file, which deletes it on every instance it is replicated to');
    assert.ok(sentenceAbout(/deleted file/i, /audit record/i, /\bfree\b/i), 'no sentence says a name only a deleted file\'s audit record holds is free');
    assert.doesNotMatch(MOVE, /\bis REPLACED\b|overwrites it\s+without asking|so read `list_dir` first if that would lose/i,
      'the old promise that a taken name is replaced is still in the description');
  });

  it('says the same in the dst parameter, which is what a caller reads while building the call', () => {
    const tool = stripComments(FILE_TOOLS.slice(FILE_TOOLS.indexOf('name: \'move_file\''), FILE_TOOLS.indexOf('name: \'retry_embed_file\'')));
    const at = tool.indexOf('dst: filePathSchema(');
    assert.ok(at > -1, 'move_file has no `dst` parameter built by filePathSchema — re-anchor this gate');
    const dst = tool.slice(at, tool.indexOf('targetSpace', at));
    assert.match(dst, /destination_exists/, 'the dst parameter does not name the refusal a taken destination answers');
    assert.doesNotMatch(dst, /\bREPLACED\b|with no warning/i, 'the dst parameter still says a taken name is replaced');
  });

  it('no longer says nothing checks the destination — in the description or in the dst parameter\'s', () => {
    const tool = FILE_TOOLS.slice(FILE_TOOLS.indexOf('name: \'move_file\''), FILE_TOOLS.indexOf('name: \'retry_embed_file\''));
    assert.ok(tool.length > 500, 'could not isolate the move_file tool — the scanner is wrong, not the code');
    assert.doesNotMatch(stripComments(tool), /NOTHING CHECKS/i,
      'a sentence claiming no check exists survives next to the check that does: a stale guarantee is worse than none');
  });

  // "A destination check appeared" is judged over the WHOLE move cascade. It used to read only `files.ts` and `stored-bytes.ts`, the
  // two files the rename lives in, while a check added in the cascade (or in the module the cascade asks) was outside it: the
  // description could be wrong and this still green. The cascade is `move-cascade.ts`; the check is `destination.ts`.
  const readIfThere = (p) => { try { return stripComments(readFileSync(p, 'utf8')); } catch { return null; } };
  const DESTINATION = readIfThere('server/src/files/destination.ts');

  it('and the refusal really is in the cascade: the destination module answers it and the move asks before its first step', () => {
    assert.ok(DESTINATION, 'server/src/files/destination.ts does not exist: nothing refuses a destination blocked by a file, so the description\'s sentence would be false');
    assert.match(DESTINATION, /export\s+(?:async\s+)?function\s+assertDestinationReachable\b/, 'the destination module no longer exports its check');
    assert.match(DESTINATION, /path_blocked/, 'the refusal no longer carries the code the doors answer with');
    // The order is read by following the calls (`_cascade-order.mjs`): the steps live in what the cascade calls, not in its body, and a
    // step nothing reaches fails. The other gate that holds this order asks the same function.
    const order = moveCascadeAsksDestinationFirst(readFileSync('server/src/files/move-cascade.ts', 'utf8'));
    assert.ok(order.guards, `the move does not ask the destination module first: ${order.why} — a refused move would already have changed something`);
  });

  it('and a taken name really is refused — the cascade asks assertDestinationFree before the call that reaches its first irreversible step', () => {
    assert.match(DESTINATION ?? '', /export\s+(?:async\s+)?function\s+assertDestinationFree\b/,
      'the destination module does not export assertDestinationFree: nothing refuses a taken destination, so the description\'s guarantee would be false');
    const order = guardPrecedesIrreversibleSteps(readFileSync('server/src/files/move-cascade.ts', 'utf8'),
      { entry: 'moveFileCascade', guard: 'assertDestinationFree', steps: MOVE_CASCADE_STEPS });
    assert.ok(order.guards, `the move does not ask whether the destination is free first: ${order.why} — a refused move would already have changed something`);
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
    // A move places its bytes through placeIfFree (the no-clobber placement a conflict resolution shares), which creates the parents.
    assert.match(bodyOfFile('moveFile'), /placeIfFree\(/, 'moveFile no longer places through placeIfFree');
    assert.match(bodyOfFile('placeIfFree'), /mkdirPrivate\(path\.dirname\(/, 'placeIfFree no longer creates the destination\'s parents');
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
