/**
 * The dispatcher skips a document only when its bytes are identical AND its processing settled or is under way, and every
 * class it declines is left in a terminal state (bundle-48, Q-260 and P9; the media half is `identical-bytes-skip-media-pipeline-db`).
 *
 * ## The two defects
 *
 * **A document has no skip at all.** The identical-bytes guard sits in the media branch only. A document that arrives again with
 * the same bytes (a peer's push that is a repeat, a pull re-recording a file, a person saving without a change) deletes the
 * conversion it already holds and enqueues the text job over it, and `enqueueTextJob` RESETS a job that is `pending` or
 * `processing` ("a re-upload means new content that must replace any in-flight work"): a second arrival of the same bytes threw
 * away a conversion that was half done, every time it arrived. The same rule the media branch holds belongs to every branch:
 * **same hash AND a status in {complete, pending, processing} skips; anything else (failed, partial, skipped) retries**.
 *
 * **A declined class is left unfinished.** Plain text (an extension the pipeline does not convert) is "stored as-is, no
 * embedding pipeline" and the dispatcher stamps nothing, so its row has NO processing state. Every other declined class is
 * stamped `skipped` (a media file over the size cap, a media class or the documents turned off for the space). A repair that asks
 * "did processing run on a class that processes" cannot tell the unstamped plain file from one whose processing never ran, and
 * would offer it for ever. Every class the dispatcher declines is therefore left with a terminal state.
 *
 * ## What is asserted, over every way bytes reach the door (a person or a peer, one request or chunked)
 *
 *   - identical bytes on a `complete`, `pending` or `processing` document: the job row is IDENTICAL (its poisoned `attempts`,
 *     `lastError` and `claimedAt` survive), the conversion's rows are still there, and the status is what it was;
 *   - identical bytes on a `failed`, `partial` or `skipped` document: converted again (a pending job, reset, the old rows gone);
 *   - CHANGED bytes, whatever the status: converted again (the control for the rule: a skip that is too eager shows here);
 *   - every declined class (an unknown extension, a media file over the cap, a media class off, documents off) leaves the row
 *     with a status that is neither unset nor `pending`/`processing`/`failed`.
 *
 * ## Seen red
 *
 * On the base the three skip statuses and the unknown extension are red on every door; the retry cases, the changed-bytes
 * controls and the other three declined classes are green and state what must keep holding.
 *
 * Run: node --test testing/standalone/a-dispatch-skips-only-settled-identical-bytes-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';
import { openDispatchDoor, sha256Of, SETTLED_STATUSES } from './_dispatch-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'dispatchskip';
const DOC = 'notes/report.md';
const FIRST = '# Report\n\nThe first version of the report.\n';
const OTHER = '# Report\n\nA corrected version of the report.\n';

/** The statuses under which identical bytes are NOT converted again: the work is done or is under way. The rest retry. */
const LEAVE_ALONE = new Set(['complete', 'pending', 'processing']);

let h;

before(async () => {
  if (skip) return;
  h = await openDispatchDoor({ suite: 'dispatchskip', space: SPACE });
});
after(async () => { await h?.close(); });

const accepted = (a) => [200, 201, 202].includes(a.code);

/** The first arrival through the door, a conversion's row beside it, then the worker's terminal write for `status`. */
async function arrangeSettled(door, status) {
  const first = await door.send(h.bytes, { space: SPACE, path: DOC, content: FIRST });
  assert.ok(accepted(first), `fixture: the first arrival was refused: ${JSON.stringify(first)}`);
  const made = await h.stateOf(DOC);
  assert.equal(made.row?.sha256, sha256Of(FIRST), 'fixture: the door recorded the bytes it was sent');
  assert.equal(made.row?.embeddingStatus, 'pending', 'fixture: a document is queued for conversion');
  assert.ok(made.job, 'fixture: the first arrival enqueued a text job');
  const chunk = await h.seedChunk(DOC);
  return { chunk, settled: await h.settle(DOC, status) };
}

describe('a document is converted again only when that could change something', { skip }, () => {
  beforeEach(async () => { await h.reset(); });

  for (const door of UPLOAD_DOORS) {
    describe(door.name, () => {
      for (const status of SETTLED_STATUSES) {
        if (LEAVE_ALONE.has(status)) {
          it(`identical bytes on a "${status}" document leave its job, status and conversion alone`, async () => {
            const { chunk, settled } = await arrangeSettled(door, status);
            const answer = await door.send(h.bytes, { space: SPACE, path: DOC, content: FIRST });
            assert.ok(accepted(answer), `the re-send was refused: ${JSON.stringify(answer)}`);
            const after = await h.stateOf(DOC);
            assert.deepEqual(after.job, settled.job,
              'the job row was reset by an arrival that changed nothing: a second arrival of the same bytes threw away work that was done or under way');
            assert.equal(after.row.embeddingStatus, status, `the status moved from "${status}" to "${after.row.embeddingStatus}"`);
            assert.ok(await h.files().findOne({ _id: chunk }), 'the conversion the document already held was deleted to be made again');
          });
        } else {
          it(`identical bytes on a "${status}" document are converted again`, async () => {
            const { chunk } = await arrangeSettled(door, status);
            const answer = await door.send(h.bytes, { space: SPACE, path: DOC, content: FIRST });
            assert.ok(accepted(answer), `the re-send was refused: ${JSON.stringify(answer)}`);
            const after = await h.stateOf(DOC);
            assert.equal(after.row.embeddingStatus, 'pending', `a "${status}" document is exactly what a re-send exists to retry`);
            assert.equal(after.job?.status, 'pending');
            assert.equal(after.job?.attempts, 0, 'the job row was not reset for the retry');
            assert.equal(await h.files().findOne({ _id: chunk }), null, 'the stale conversion was left beside the new one');
          });
        }

        it(`CHANGED bytes on a "${status}" document are converted again, under the new hash`, async () => {
          const { chunk } = await arrangeSettled(door, status);
          const answer = await door.send(h.bytes, { space: SPACE, path: DOC, content: OTHER });
          assert.ok(accepted(answer), `the re-send was refused: ${JSON.stringify(answer)}`);
          const after = await h.stateOf(DOC);
          assert.equal(after.row.sha256, sha256Of(OTHER), 'fixture: the row holds the new bytes');
          assert.equal(after.row.embeddingStatus, 'pending');
          assert.equal(after.job?.status, 'pending');
          assert.equal(after.job?.attempts, 0, 'the old job\'s attempts carried over to the new bytes');
          assert.equal(await h.files().findOne({ _id: chunk }), null, 'the old conversion survived the new bytes');
        });
      }
    });
  }
});

/**
 * The classes the dispatcher declines, each as a way to arrive at "stored, and not analysed": how to make the file and what to
 * change in the live config first (`undo` puts it back). A class is a row here, so one added to the dispatcher is a row to add.
 */
const DECLINED = [
  { name: 'an unknown extension (plain text)', path: 'data/readings.dat', content: 'a,b,c\n1,2,3\n' },
  { name: 'a media file over the size cap', path: 'img/big.png', content: 'more bytes than the cap allows',
    prepare: (cfg) => { h.capMediaBytes(4); return () => h.capMediaBytes(null); } },
  { name: 'a media class turned off for the space', path: 'img/off.png', content: 'a picture in a space that analyses none',
    prepare: (cfg) => { const s = cfg.spaces.find(x => x.id === SPACE); const was = s.imageAnalysis; s.imageAnalysis = 'off';
      return () => { if (was === undefined) delete s.imageAnalysis; else s.imageAnalysis = was; }; } },
  { name: 'documents turned off for the space', path: 'doc/off.md', content: '# Off\n\ndocuments are not analysed here\n',
    prepare: (cfg) => { const s = cfg.spaces.find(x => x.id === SPACE); const was = s.documentExtraction; s.documentExtraction = 'off';
      return () => { if (was === undefined) delete s.documentExtraction; else s.documentExtraction = was; }; } },
];

/** A state a file can be left in that says "nothing more will happen to it" — and not `failed`, which a retry picks up. */
const TERMINAL = new Set(['complete', 'skipped', 'disabled']);

describe('every class the dispatcher declines is left in a terminal state', { skip }, () => {
  beforeEach(async () => { await h.reset(); });
  assert.ok(DECLINED.length >= 4, 'the declined classes are a table with a floor: an empty one passes every loop written over it');

  for (const door of UPLOAD_DOORS) {
    describe(door.name, () => {
      for (const cls of DECLINED) {
        it(`${cls.name}`, async () => {
          const undo = cls.prepare?.(h.loader.getConfig());
          try {
            const answer = await door.send(h.bytes, { space: SPACE, path: cls.path, content: cls.content });
            assert.ok(accepted(answer), `fixture: the arrival was refused: ${JSON.stringify(answer)}`);
            const { row } = await h.stateOf(cls.path);
            assert.equal(row?.sha256, sha256Of(cls.content), 'fixture: the file is recorded under the bytes it was sent');
            assert.ok(TERMINAL.has(row.embeddingStatus),
              `${cls.name}: stored and not analysed, and its row says "${row.embeddingStatus}" — a repair cannot tell it from a file whose processing never ran`);
          } finally { undo?.(); }
        });
      }
    });
  }
});
