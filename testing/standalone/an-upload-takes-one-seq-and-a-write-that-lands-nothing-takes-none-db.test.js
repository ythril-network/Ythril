/**
 * One upload stamps ONE row seq, and the space counter moves only when a row is stamped (bundle-89, E1 / Q-424).
 *
 * ## What the ticket said, and what the code does
 *
 * Q-424 reported that a re-upload of a file takes two seqs: a drive of upload, describe, re-upload moved the space
 * counter 1 -> 3. Read against the code, no record is ever stamped twice. The counter moves for another reason:
 * `withAllocatedSeqs` (`util/seq.ts`) runs the `$inc` on `ythril_counters` and only THEN calls the write. So a guarded write
 * whose filter matches nothing still consumes a number. `setDerivedDescriptionIfUnset` (`files/file-meta.ts`) runs after
 * every job that derived a description, and its filter requires the description to be absent; on a file uploaded WITH a
 * description it writes nothing and burns a number anyway.
 *
 *     upload            counter 0 -> 1   row seq 1
 *     worker, no-op     counter 1 -> 2   (no row carries 2)
 *     re-upload         counter 2 -> 3   row seq 3
 *
 * That is the reported 1 -> 3, and it is not "a re-upload takes two seqs". It inflates the counter every peer pages by, for
 * a write that never happened.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * Two rules, over every door a person's bytes reach (one request with a description, one request without, chunked):
 *
 *   1. **One upload stamps one row seq.** The counter moves by exactly one and the PARENT row's STORED `seq` is that number,
 *      for the first upload and for a re-upload. Asserted on the stored row, never on a `withSeq` label: labels reach only
 *      `HorizonHolds.enter`, `seqHolds` is unexported, and a label is logged only when a hold outlives half its deadline,
 *      so a label has no seam to assert on. (The real labels are `file.upsert`, `file.describe`, `file.update`;
 *      `file.create` is an audit operation name, not a seq label.) This rule is a FORWARD guard: green on the code as it
 *      stands, and seen red by putting a second stamping `withSeq` into `upsertFileMeta`'s update branch.
 *   2. **A write that lands nothing takes no seq.** The counter does not move when the guarded derived-description write
 *      declines, whatever the reason it declines for. RED on the code as it stands: this is the burn.
 *
 * It does NOT assert the burn. A test that pinned "the worker moves the counter by one over a described file" would lock the
 * inefficiency in. And it asserts a write that DOES land stamps exactly the row it landed on (the control), so a fix that
 * stopped stamping altogether fails too.
 *
 * ## Why through the real worker
 *
 * The drive that reported it ran with processing ON. Models are offline here (`_byte-door.mjs`), but the document pipeline
 * and `describeDocument`'s extracted fallback need none, and the embedder is a local stub, so the worker runs to the end of
 * its job the way it does on an instance, claiming it through its own loop (`processJob` is not exported).
 *
 * Run: node --test testing/standalone/an-upload-takes-one-seq-and-a-write-that-lands-nothing-takes-none-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { USER_TOKEN } from './_byte-door.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';

const skip = await mongoSkipReason();

const SPACE = 'uploadseq';
const FILE = 'notes/report.md';
const DIMS = 8;
const DESCRIBED_BY_A_PERSON = 'Written by the person who uploaded it';
const FIRST = '# Quarterly report\n\nThe first version of a short document the pipeline converts and describes.\n';
const SECOND = '# Quarterly report\n\nA corrected version, with different bytes, so the re-upload is not skipped as identical.\n';

process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let h;
let worker;
let fileMeta, derivedFields;
let embedder;

/** Every way a PERSON's bytes reach the byte door, and whether the door can carry a description with them. */
const PERSON_DOORS = Object.freeze([
  {
    name: 'a person, one request, with a description', described: true,
    // The JSON body is how the door takes a description; a raw body carries only bytes.
    send: (content) => h.bytes.post({ space: SPACE, path: FILE, bytes: { content, description: DESCRIBED_BY_A_PERSON }, token: USER_TOKEN }),
  },
  {
    name: 'a person, one request, without a description', described: false,
    send: (content) => UPLOAD_DOORS[0].send(h.bytes, { space: SPACE, path: FILE, content }),
  },
  {
    name: 'a person, chunked (carries no description)', described: false,
    send: (content) => UPLOAD_DOORS[1].send(h.bytes, { space: SPACE, path: FILE, content }),
  },
]);

before(async () => {
  if (skip) return;
  embedder = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = JSON.parse(body).input;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
    });
  });
  const local = await listenOnLoopback(embedder);
  process.env['EMBEDDING_URL'] = local.url;
  embedder.closeLocal = local.close;
  const { openDispatchDoor } = await import('./_dispatch-door.mjs');
  h = await openDispatchDoor({ suite: 'uploadseq', space: SPACE });
  h.loader.getConfig().mediaEmbedding = { workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200 };
  worker = await import('../../server/dist/files/media/worker.js');
  fileMeta = await import('../../server/dist/files/file-meta.js');
  // The derived-description writer moved to the one writer of a field derived from a file's bytes (bundle-89).
  derivedFields = await import('../../server/dist/files/derived-fields.js');
});

after(async () => {
  try { worker?.stopMediaEmbeddingWorker(); } catch { /* never started */ }
  await h?.close();
  await embedder?.closeLocal?.();
});

/**
 * The space counter, the parent file's stored row, and the highest seq any row of the files collection carries (a chunk the
 * conversion made is a row of the same collection), once every counter write already started has landed.
 */
async function state() {
  const top = await h.files().find({ seq: { $type: 'number' } }, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  return { counter: await h.door.counter(SPACE), row: await h.files().findOne({ _id: FILE }), topSeq: top[0]?.seq ?? 0 };
}

/** Run the worker over the one job in the queue until the job and the file are both terminal, then stop it. */
async function runWorker() {
  worker.startMediaEmbeddingWorker();
  try {
    await waitFor(async () => ['complete', 'failed'].includes((await h.jobs().findOne({ _id: FILE }))?.status)
      && !['pending', 'processing'].includes((await h.files().findOne({ _id: FILE }))?.embeddingStatus),
    30_000, 100, async () => `the worker never finished the job for ${FILE}: ${JSON.stringify(await h.jobs().findOne({ _id: FILE }))}`
      + ` / file ${JSON.stringify(await h.files().findOne({ _id: FILE }, { projection: { embeddingStatus: 1 } }))}`);
  } finally {
    worker.stopMediaEmbeddingWorker();
  }
}

describe('one upload stamps one row seq, and a write that lands nothing takes none (real MongoDB, worker running)', { skip }, () => {
  beforeEach(async () => { await h.reset(); });

  for (const door of PERSON_DOORS) {
    it(`${door.name}: every move of the space counter is a row that was stamped (upload, worker, re-upload, worker)`, async () => {
      const trace = [];
      const at = (name, s) => {
        trace.push({ step: name, counter: s.counter, parentSeq: s.row?.seq, topSeqInCollection: s.topSeq, description: s.row?.description, source: s.row?.descriptionSource });
        return s;
      };
      const dump = () => `\nthe drive, step by step: ${JSON.stringify(trace, null, 1)}`;

      const start = at('empty space', await state());
      assert.equal(start.counter, 0, `fixture: the space was not empty${dump()}`);

      // ── the upload ──────────────────────────────────────────────────────────────────────────────────────────────────
      const up = await door.send(FIRST);
      assert.ok([200, 201, 202].includes(up.code), `fixture: the upload was refused: ${JSON.stringify(up)}`);
      const uploaded = at('uploaded', await state());
      assert.equal(uploaded.counter - start.counter, 1,
        `one upload moved the space counter by ${uploaded.counter - start.counter}, not one${dump()}`);
      assert.equal(uploaded.row?.seq, uploaded.counter,
        `the upload moved the counter to ${uploaded.counter} and the row it wrote carries seq ${uploaded.row?.seq}: a number was taken `
        + `that no row holds${dump()}`);
      if (door.described) assert.equal(uploaded.row.description, DESCRIBED_BY_A_PERSON, 'fixture: the door did not carry the description');
      else assert.ok(!uploaded.row?.description, 'fixture: the file was uploaded with a description it should not have');

      // ── the worker converts the document and derives a description for it ─────────────────────────────────────────────
      await runWorker();
      const processed = at('worker finished', await state());
      assert.equal(processed.row?.embeddingStatus, 'complete', `fixture: the worker did not complete the file${dump()}`);
      if (door.described) {
        // The derived description has nowhere to go: the person wrote one, so the guarded write matches nothing.
        assert.equal(processed.row.description, DESCRIBED_BY_A_PERSON, `the person's description was replaced${dump()}`);
        assert.equal(processed.row.seq, uploaded.row.seq, `the worker stamped a row that is the person's${dump()}`);
        assert.equal(processed.counter, uploaded.counter,
          `the worker wrote nothing to this file and moved the space counter from ${uploaded.counter} to ${processed.counter}: `
          + `the derived-description write was declined by its own filter AFTER it took a number, so the counter now names a seq `
          + `no record holds, and every peer pages past it${dump()}`);
      } else {
        // The control. A derived description that LANDS is an authored write: it takes one number and stamps its own row.
        assert.ok(processed.row.description, `fixture: the worker derived no description, so this case drove nothing${dump()}`);
        assert.equal(processed.counter - uploaded.counter, 1,
          `a derived description that landed moved the counter by ${processed.counter - uploaded.counter}, not one${dump()}`);
        assert.equal(processed.row.seq, processed.counter,
          `the write that landed the description did not stamp the row it landed on${dump()}`);
      }

      // ── the re-upload, with different bytes ───────────────────────────────────────────────────────────────────────────
      const again = await door.send(SECOND);
      assert.ok([200, 201, 202].includes(again.code), `fixture: the re-upload was refused: ${JSON.stringify(again)}`);
      const reuploaded = at('re-uploaded', await state());
      assert.equal(reuploaded.counter - processed.counter, 1,
        `a re-upload moved the space counter by ${reuploaded.counter - processed.counter}, not one${dump()}`);
      assert.equal(reuploaded.row?.seq, reuploaded.counter,
        `the re-upload moved the counter to ${reuploaded.counter} and the row carries seq ${reuploaded.row?.seq}${dump()}`);

      // ── and the worker over the re-uploaded bytes: a described file is still described, and still costs nothing ─────
      await runWorker();
      const reprocessed = at('worker finished again', await state());
      if (door.described) {
        assert.equal(reprocessed.row.description, DESCRIBED_BY_A_PERSON, `the re-upload's processing replaced the person's description${dump()}`);
        assert.equal(reprocessed.counter, reuploaded.counter,
          `the worker over a described file's second version moved the counter from ${reuploaded.counter} to ${reprocessed.counter}${dump()}`);
        assert.equal(reprocessed.row.seq, reuploaded.row.seq, `the worker re-stamped the row${dump()}`);
      }
    });
  }

  describe('a derived-description write that lands nothing takes no seq, for each reason its filter declines', () => {
    const peerRow = () => ({
      _id: FILE, spaceId: SPACE, path: FILE, tags: [], sizeBytes: 10, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      author: { instanceId: 'some-other-instance', instanceLabel: 'Peer' }, seq: 5,
    });

    /** Each way the filter declines; `arrange` leaves the space and the row as the case needs. */
    const DECLINES = [
      { name: 'a person already wrote a description',
        arrange: async () => { await fileMeta.upsertFileMeta(SPACE, FILE, 10, { description: 'MINE' }); } },
      { name: 'the file was authored by another instance (its description replicates from the author)',
        arrange: async () => {
          await h.files().insertOne(peerRow());
          await h.door.setCounter(SPACE, 5);
        } },
      { name: 'there is no row for the path at all',
        arrange: async () => { await h.door.setCounter(SPACE, 5); } },
    ];

    for (const c of DECLINES) {
      it(`${c.name}: the write reports it wrote nothing and the counter stays where it was`, async () => {
        await c.arrange();
        const before = await h.door.counter(SPACE);
        const wrote = await derivedFields.setDerivedDescriptionIfUnset(SPACE, FILE, 'A derived summary', 'extracted');
        const after = await h.door.counter(SPACE);
        assert.equal(wrote, false, 'fixture: the derived write landed, so this case drove no decline');
        assert.equal(await h.files().countDocuments({ description: 'A derived summary' }), 0, 'fixture: a derived description was stored');
        assert.equal(after, before,
          `a derived-description write that matched nothing moved the space counter from ${before} to ${after}: it allocated its seq `
          + 'before its filter was asked, so no record holds the number it consumed');
      });
    }

    it('the control: a derived write that LANDS takes one number and stamps the row it landed on', async () => {
      await fileMeta.upsertFileMeta(SPACE, FILE, 10, {});
      const before = await h.door.counter(SPACE);
      const wrote = await derivedFields.setDerivedDescriptionIfUnset(SPACE, FILE, 'A derived summary', 'extracted');
      const after = await h.door.counter(SPACE);
      assert.equal(wrote, true, 'fixture: the derived write declined on a file nobody had described');
      assert.equal(after - before, 1, 'a write that landed took more or fewer than one number');
      assert.equal((await h.files().findOne({ _id: FILE })).seq, after, 'the row the description landed on was not stamped with the number taken');
    });
  });
});
