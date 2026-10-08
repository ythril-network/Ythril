/**
 * Re-sending identical bytes does not re-run vision or speech-to-text over them, and CHANGED bytes always do — asked of every
 * way bytes arrive, through the door, never against a row a test wrote (bundle-48, Q-260).
 *
 * ## The waste, and the rule that came with it
 *
 * `enqueueMediaJob` resets a terminal job on purpose ("so re-upload triggers re-processing"): until the pipeline could tell a
 * corrected file from the same file sent twice, every re-upload paid for a full vision or speech-to-text pass, the single
 * most expensive thing this instance does, to reproduce a caption it already had. The guard that stopped it is an identity,
 * not a guess: the same bytes (SHA-256) through the same pipeline produce the same analysis. It fires only when the stored
 * hash matches AND the file's processing settled or is under way (`complete`, `pending`, `processing`); a `failed`, `partial`
 * or `skipped` file is retried, because those are exactly the states a retry exists for. The wrong direction is invisible: a
 * file silently never embedded is discovered only when someone searches for it and it is not there. So every uncertain case
 * processes.
 *
 * ## What this file used to do wrong (the defect bundle-48 fixes)
 *
 * It seeded the PRIOR row by hand and called the dispatcher with it. Through a real door the row is rewritten by the arrival
 * (the new size, the new hash) BEFORE the dispatcher reads it, so the comparison of "the stored hash" with "the arriving
 * hash" compared the arriving hash with itself: CHANGED bytes on a `complete` file were skipped, and left `complete` under the
 * new hash, with the old caption, for ever. Nothing here seeds a hash. The first arrival is the door's; only the worker's own
 * terminal write is stood in for (`settle`, `_dispatch-door.mjs`).
 *
 * ## What is asserted, over every way bytes reach the door (a person or a peer, one request or chunked) and every status
 *
 *   - identical bytes on a `complete`, `pending` or `processing` file: nothing is touched. The job row is IDENTICAL (its
 *     poisoned `attempts`, `lastError` and `claimedAt` survive), the file's status is what it was, and a `complete` file is
 *     answered `complete`;
 *   - identical bytes on a `failed`, `partial` or `skipped` file: processed again (a pending job, reset);
 *   - CHANGED bytes, whatever the status: processed (the file is `pending` under the NEW hash, a terminal job reset);
 *   - identical bytes on a row that holds no hash (every media file stored before the hash existed): processed;
 *   - in source: every call of the dispatcher hands over the hash, no door keeps a private copy of the sequence that could
 *     forget it, and a writer without a hash never erases the stored one.
 *
 * Run: node --test testing/standalone/identical-bytes-skip-media-pipeline-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';
import { openDispatchDoor, sha256Of, SETTLED_STATUSES } from './_dispatch-door.mjs';
import { trackedSources } from './_sources.mjs';

const skip = await mongoSkipReason();

const SPACE = 'mediaskip';
const FILE = 'clip.png';
const FIRST = 'the bytes of the first picture';
const OTHER = 'the bytes of a corrected picture';

/** The statuses under which identical bytes are NOT processed again: the work is done or is under way. The rest retry. */
const LEAVE_ALONE = new Set(['complete', 'pending', 'processing']);
/** A terminal job a re-run must reset (a job in flight is left to its worker). */
const TERMINAL_JOB = new Set(['complete', 'partial', 'failed']);

let h;

before(async () => {
  if (skip) return;
  h = await openDispatchDoor({ suite: 'mediaskip', space: SPACE });
});
after(async () => { await h?.close(); });

/** The first arrival through the door, then the worker's terminal write for `status`. Returns the settled state. */
async function arrangeSettled(door, status, content = FIRST) {
  const first = await door.send(h.bytes, { space: SPACE, path: FILE, content });
  assert.ok([200, 201, 202].includes(first.code), `fixture: the first arrival was refused: ${JSON.stringify(first)}`);
  const made = await h.stateOf(FILE);
  assert.equal(made.row?.sha256, sha256Of(content), 'fixture: the door recorded the bytes it was sent');
  assert.equal(made.row?.mediaType, 'image', 'fixture: the file is media');
  assert.ok(made.job, 'fixture: the first arrival enqueued a media job');
  return h.settle(FILE, status);
}

describe('the media pipeline runs again only when running it could change something', { skip }, () => {
  beforeEach(async () => { await h.reset(); });

  // The partition is stated by SETTLED_STATUSES (every status a worker or the dispatcher leaves), so a status added there is
  // asked of every door below instead of being a case nobody wrote.
  assert.ok(SETTLED_STATUSES.length >= 6 && [...LEAVE_ALONE].every(s => SETTLED_STATUSES.includes(s)),
    'the settled statuses are derived from what a worker leaves; a floor keeps an empty list from passing every loop');

  for (const door of UPLOAD_DOORS) {
    describe(door.name, () => {
      for (const status of SETTLED_STATUSES) {
        if (LEAVE_ALONE.has(status)) {
          it(`identical bytes on a "${status}" file are left exactly as they are`, async () => {
            const before = await arrangeSettled(door, status);
            const answer = await door.send(h.bytes, { space: SPACE, path: FILE, content: FIRST });
            assert.ok([200, 201, 202].includes(answer.code), `the re-send was refused: ${JSON.stringify(answer)}`);
            const after = await h.stateOf(FILE);
            assert.equal(after.row.embeddingStatus, status,
              `identical bytes changed the file's status from "${status}" to "${after.row.embeddingStatus}": work that was done or under way was thrown away`);
            if (before.job) assert.deepEqual(after.job, before.job, 'the job row was touched by an arrival that changed nothing');
            if (status === 'complete') {
              assert.equal(answer.body.embeddingStatus, 'complete',
                'the caller is told the truth about the file, not a status describing work that did not happen');
            }
          });
        } else {
          it(`identical bytes on a "${status}" file are processed again`, async () => {
            await arrangeSettled(door, status);
            const answer = await door.send(h.bytes, { space: SPACE, path: FILE, content: FIRST });
            assert.ok([200, 201, 202].includes(answer.code), `the re-send was refused: ${JSON.stringify(answer)}`);
            const after = await h.stateOf(FILE);
            assert.equal(after.row.embeddingStatus, 'pending', `a "${status}" file is exactly what a re-send exists to retry`);
            assert.equal(after.job?.status, 'pending', 'the retry enqueued nothing');
            assert.equal(after.job?.attempts, 0, 'the job row was not reset for the retry');
          });
        }

        it(`CHANGED bytes on a "${status}" file are processed, under the new hash`, async () => {
          await arrangeSettled(door, status);
          const answer = await door.send(h.bytes, { space: SPACE, path: FILE, content: OTHER });
          assert.ok([200, 201, 202].includes(answer.code), `the re-send was refused: ${JSON.stringify(answer)}`);
          const after = await h.stateOf(FILE);
          assert.equal(after.row.sha256, sha256Of(OTHER), 'fixture: the row holds the new bytes');
          assert.equal(after.row.embeddingStatus, 'pending',
            `new bytes on a "${status}" file left it "${after.row.embeddingStatus}" under the new hash: the old analysis now describes a file that is gone`);
          assert.equal(answer.body.embeddingStatus, 'pending', 'the caller was told the old analysis stands');
          assert.ok(after.job, 'no job exists for the new bytes');
          if (TERMINAL_JOB.has(status) || status === 'skipped') {
            assert.equal(after.job.status, 'pending', 'a finished job was not reset for the new bytes');
            assert.equal(after.job.attempts, 0, 'the old job\'s attempts carried over to the new bytes');
          }
        });
      }

      it('identical bytes on a row that holds NO hash are processed (every record stored before the hash existed)', async () => {
        await arrangeSettled(door, 'complete');
        await h.files().updateOne({ _id: FILE }, { $unset: { sha256: '' } });
        const answer = await door.send(h.bytes, { space: SPACE, path: FILE, content: FIRST });
        assert.ok([200, 201, 202].includes(answer.code), `the re-send was refused: ${JSON.stringify(answer)}`);
        const after = await h.stateOf(FILE);
        assert.equal(after.row.embeddingStatus, 'pending', 'a record that never stored a hash cannot claim identity');
        assert.equal(after.job?.attempts, 0, 'the job was not reset for a file whose identity is unknown');
      });
    });
  }
});

describe('the writers supply the hash, or the guard is dead code', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*/gm, '$1');

  /** The text between the parentheses of the call that opens at `from` (just after its `(`), balanced. */
  function argsOf(text, from) {
    let depth = 1;
    for (let i = from; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) return text.slice(from, i);
    }
    throw new Error('an unbalanced call');
  }

  it('every call of the dispatcher hands over the hash it has', () => {
    const calls = [];
    for (const file of trackedSources('server/src', { floor: 200 })) {
      const src = strip(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/(?<![\w.])dispatchFileProcessing\(/g)) {
        if (/function\s+$/.test(src.slice(0, m.index))) continue; // its own definition
        calls.push({ file, args: argsOf(src, m.index + m[0].length) });
      }
    }
    assert.ok(calls.length >= 1, 'no call of dispatchFileProcessing found: the scan is broken, not the code');
    for (const { file, args } of calls) {
      assert.match(args, /\bsha256\b/, `${file} calls the dispatcher without the hash of the bytes: unknown means "process", so every arrival pays for the pipeline`);
    }
  });

  it('no door keeps a private copy of the sequence that could forget the hash', () => {
    const doors = ['server/src/api/files-upload.ts', 'server/src/mcp/tools/file.ts'];
    for (const file of doors) {
      const src = strip(readFileSync(file, 'utf8'));
      assert.doesNotMatch(src, /\b(upsertFileMeta|dispatchFileProcessing)\(/,
        `${file} writes metadata or dispatches itself — a private copy of the sequence is where the hash gets dropped`);
      assert.match(src, /\b(storeFile|recordStoredFile)\(/, `${file} must store through files/store-file.ts`);
    }
  });

  it('the stored hash is never erased by a writer that does not have one', () => {
    const meta = strip(readFileSync('server/src/files/file-meta.ts', 'utf8'));
    // An unconditional `$set` would turn "unknown" into a permanent state — a `PATCH` of a description would
    // silently disarm the skip for that file for ever.
    assert.match(meta, /if \(opts\.sha256 !== undefined\) \$set\['sha256'\] = opts\.sha256;/,
      'the hash is written only when the caller states one');
  });
});
