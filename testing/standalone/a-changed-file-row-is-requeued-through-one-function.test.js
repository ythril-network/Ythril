/**
 * Every write that changes a file row's embed text re-queues the row through ONE function, `requeueEmbedWorkOfChangedRow`
 * (`server/src/files/file-embed-work.ts`), never through its own `enqueueEmbedJob(…, 'file', …)` (Q-428, bundle-41).
 *
 * ## Why one function
 *
 * Four writers change a file row's embed text: the derived excerpt, the derived description, and the two metadata writes of `file-meta.ts`.
 * Each queued its own job, and the derived description, the fourth, forgot to (Q-428). The rule a writer must keep is not only "queue", it is
 * "queue on the write lane, AFTER the transaction, and never throw into a write that already landed": an enqueue that threw after the
 * description landed was swallowed as "failed to write description" and never retried, because the description was then set. That guard lives
 * inside the one function (bounded and said once, as `requeueEmbedWorkOfMovedRows` is), so no writer can drop it.
 *
 * ## What it holds, over the server's whole source (comments blanked, sites derived)
 *
 *  1. `file-embed-work.ts` exports `requeueEmbedWorkOfChangedRow`.
 *  2. No `enqueueEmbedJob`, `enqueueEmbedJobs` or `enqueueWriteEmbedJobs` call whose record type is `'file'` stands anywhere in `server/src`
 *     outside `file-embed-work.ts` (round-1 finding F12: the first version looked at `enqueueEmbedJob` alone, so a direct batch call passed).
 *     The detector is stated over each spelling, a planted copy of each, so it cannot go blind to one.
 *  3. The four writers call it: `setDerivedExcerpt` and `setDerivedDescriptionIfUnset` (`derived-fields.ts`), `upsertFileMeta` and
 *     `updateFileMeta` (`file-meta.ts`).
 *
 * Seen red on 890cf234b: the function does not exist, and three direct `enqueueEmbedJob(spaceId, 'file', …)` calls stand in the writers.
 *
 * Run: node --test testing/standalone/a-changed-file-row-is-requeued-through-one-function.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callSitesOf, serverSources } from './_call-sites.mjs';

const HOME = 'server/src/files/file-embed-work.ts';
const FN = 'requeueEmbedWorkOfChangedRow';
/** The writers that change a file row's embed text, by the file they are written in. */
const WRITERS = [
  { file: 'server/src/files/derived-fields.ts', fn: 'setDerivedExcerpt' },
  { file: 'server/src/files/derived-fields.ts', fn: 'setDerivedDescriptionIfUnset' },
  { file: 'server/src/files/file-meta.ts', fn: 'upsertFileMeta' },
  { file: 'server/src/files/file-meta.ts', fn: 'updateFileMeta' },
];

const norm = (f) => f.replace(/\\/g, '/');
/** The second argument of a call's argument text, trimmed (the record type). */
const secondArg = (args) => {
  let depth = 0; const parts = ['']; for (const ch of args) {
    if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) parts.push(''); else parts[parts.length - 1] += ch;
  }
  return (parts[1] ?? '').trim();
};

/** The three queue entry points a writer could re-queue a file row through by hand: the single, the sweep's batch and the write lane's batch. */
const QUEUE_CALLS = ['enqueueEmbedJob', 'enqueueEmbedJobs', 'enqueueWriteEmbedJobs'];
/**
 * Does this call queue a `file` record? The record type is the second argument of the first two (`'file'`), and a `recordType: 'file'` member of
 * the list the write lane's batch takes. A record type held in a variable (the reembed sweep's `kind`) is no file writer's.
 */
function queuesAFileRow({ name, args }) {
  if (name === 'enqueueWriteEmbedJobs') return /\brecordType\s*:\s*['"`]file['"`]/.test(args);
  return /^['"`]file['"`]$/.test(secondArg(args));
}

describe('a changed file row is re-queued for embedding through one function', () => {
  it(`${HOME} exports ${FN}`, () => {
    const { blanked } = serverSources();
    const text = [...blanked].find(([f]) => norm(f).endsWith(HOME))?.[1];
    assert.ok(text, `${HOME} was not found among the server sources`);
    assert.match(text, new RegExp(`export\\s+async\\s+function\\s+${FN}\\s*\\(`), `${HOME} does not export ${FN}: there is no one function that re-queues a changed file row`);
  });

  it(`no enqueueEmbedJob, enqueueEmbedJobs or enqueueWriteEmbedJobs of a 'file' job stands outside ${HOME}`, () => {
    const sites = QUEUE_CALLS.flatMap(name => callSitesOf(name).map(s => ({ ...s, name })));
    assert.ok(callSitesOf('enqueueEmbedJob').length >= 3, 'fixture: fewer than three enqueueEmbedJob calls were found; the scan stopped seeing calls');
    assert.ok(callSitesOf('enqueueWriteEmbedJobs').length >= 3, 'fixture: fewer than three enqueueWriteEmbedJobs calls were found; the scan stopped seeing calls');
    const direct = sites.filter(s => queuesAFileRow(s) && !norm(s.file).endsWith(HOME))
      .map(s => `${norm(s.file)} (${s.fn ?? 'module scope'}): ${s.name}(${s.args.replace(/\s+/g, ' ')})`);
    assert.deepEqual(direct, [], `file rows re-queued by hand, each free to drop the write lane or the never-throw guard; call ${FN} instead`);
  });

  it('the detector sees each spelling of a file row queued by hand, and not another record type (round-1 finding F12: a planted copy)', () => {
    const planted = (name, args) => ({ name, args, file: 'server/src/files/elsewhere.ts', fn: 'f' });
    assert.ok(queuesAFileRow(planted('enqueueEmbedJob', "spaceId, 'file', id, { priority }")), 'enqueueEmbedJob(…, \'file\', …)');
    assert.ok(queuesAFileRow(planted('enqueueEmbedJobs', "spaceId, 'file', ids, { priority }")), 'enqueueEmbedJobs(…, \'file\', …)');
    assert.ok(queuesAFileRow(planted('enqueueWriteEmbedJobs', "spaceId, [{ recordType: 'file', recordId: id }], { priority }")), 'enqueueWriteEmbedJobs([{ recordType: \'file\' }])');
    assert.ok(queuesAFileRow(planted('enqueueWriteEmbedJobs', 'spaceId, ids.map(id => ({ recordType: "file" as const, recordId: id })), { priority }')), 'a mapped list of file records');
    assert.ok(!queuesAFileRow(planted('enqueueEmbedJob', "spaceId, 'fact', id, { priority }")), 'a fact is not a file row');
    assert.ok(!queuesAFileRow(planted('enqueueWriteEmbedJobs', "spaceId, [{ recordType: 'edge', recordId: id }], { priority }")), 'an edge is not a file row');
    assert.ok(!queuesAFileRow(planted('enqueueEmbedJobs', 'spaceId, kind, batch, { priority }')), 'a record type that is a variable is the sweep\'s, not a file writer\'s');
  });

  for (const { file, fn } of WRITERS) {
    it(`${fn} re-queues its row through ${FN}`, () => {
      const calls = callSitesOf(FN).filter(s => norm(s.file).endsWith(file) && s.fn === fn);
      assert.ok(calls.length >= 1, `${file}: ${fn} changes a file row's embed text and does not call ${FN}`);
    });
  }
});
