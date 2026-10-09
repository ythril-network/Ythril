/**
 * The edge refusal is PURE: asking it records nothing, writes nothing and embeds nothing (`Q-170`, design 1).
 *
 * ## The rule
 *
 * `edgeRefusal` is asked from two places for one edge — by a door BEFORE the record the inline edge hangs off is
 * written, and by `planEdge` before the writer decides. The first ask exists so that a refusal leaves NOTHING
 * behind, and it can only promise that if asking changes nothing:
 *
 *  - **`noteWritten(`** records the plan in the read set, after which a later item of the same batch treats the
 *    edge as already written. A refusal that noted would leave a phantom edge behind in a batch whose item was
 *    refused — the very state the refusal exists to prevent.
 *  - **`vectorBeforeWrite(`** starts the embedding of the record; an edge that is about to be refused would pay
 *    for a model call, and an inline pre-check would pay it for an edge the caller never wrote.
 *  - **A collection** — `a-write-planner-touches-no-collection` holds every `plan-*.ts` to reading the store only
 *    through the read set. The refusal is asked from doors that have no read set to hand over, so it is allowed to
 *    live in a file that is NOT named `plan-*.ts`; this holds the file it lives in to the same rule, so moving it
 *    out of that gate's sight is not a way around it.
 *
 * ## What is derived
 *
 * The file is whichever file under `brain/write-plan/` declares `edgeRefusal` (`_write-plan-sources.mjs`, which
 * throws when there is none or two). Comments are stripped before anything is read. The collection-touch lists are
 * `_collection-touches.mjs`, shared with the planner gate and derived from `db/record-write-observer.ts`.
 *
 * ## Seen red
 *
 * Red on c6bb1aa0: `edgeRefusal` does not exist. Mutations the implementer must run once it does (restore by hand):
 * add `view.noteWritten(` to its body; add `vectorBeforeWrite(` to its body; add a `col(` call to the file it is in.
 *
 * Run: node --test testing/standalone/an-edge-refusal-writes-nothing-and-embeds-nothing.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writePlanFunction } from './_write-plan-sources.mjs';
import { collectionTouches, COLLECTION_METHODS } from './_collection-touches.mjs';

describe('the edge refusal exists to be asked', () => {
  it('edgeRefusal is declared once under write-plan/ and is the real refusal, not a stub', () => {
    const { body } = writePlanFunction('edgeRefusal');
    assert.match(body, /classifyEdgeUpsertAgainst\(/,
      'the window found for edgeRefusal holds no classifier call — either it is a stub, or the window missed the body');
  });

  it('the derived collection method list is not empty (floor)', () => {
    assert.ok(COLLECTION_METHODS.length >= 25 && COLLECTION_METHODS.includes('findOne'),
      `only ${COLLECTION_METHODS.length} collection methods derived — every no-touch assertion below passes over an empty list`);
  });
});

describe('asking the edge refusal changes nothing', () => {
  it('it does not record the edge in the read set', () => {
    const { body } = writePlanFunction('edgeRefusal');
    assert.doesNotMatch(body, /\bnoteWritten\(/,
      'edgeRefusal notes a write into the read set. It is asked BEFORE the record is written and for edges that may '
      + 'be refused, so a note is a phantom edge that later items of the batch treat as stored');
  });

  it('it does not start an embedding', () => {
    const { body } = writePlanFunction('edgeRefusal');
    assert.doesNotMatch(body, /\bvectorBeforeWrite\(/,
      'edgeRefusal starts the embedding for an edge that is about to be refused (or has not been written yet)');
  });

  it('the file it lives in never opens a collection', () => {
    const { file, src } = writePlanFunction('edgeRefusal');
    assert.deepEqual(collectionTouches(src), [],
      `${file} touches the store directly. The refusal reads through the read set it is handed — one query per kind `
      + 'for a batch, with the earlier plans overlaid — and writes nothing');
  });
});
