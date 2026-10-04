/**
 * Every sentence of a too-large merge refusal refers to something its reader can see or do (bundle-30 I7).
 *
 * The refusal (`MergeTooLarge`, `brain/merge.ts`) is the one text every merge door answers: a toast on Brain -> Review
 * -> Duplicates, the `error` of a REST 422, the text of a `graph_merge` result, and automerge's warning. Read from the
 * Review page it used to fail twice. It named the two entities by id, which that page never shows (both cards show a
 * name), so the reader could not tell which card would have been absorbed. And it said "move or delete some of its
 * edges", although no door can move an edge: an edge's ends are not patchable, so the only real instruction was half
 * of one.
 *
 * What it must say, and what each case below holds:
 *  - both entities by NAME, in their roles (the ids may follow, for an API caller);
 *  - the count, by kind, and the bound; and that nothing was written;
 *  - delete edges or links the absorbed entity no longer needs, and how many — only when that CAN bring the merge
 *    under the bound (no door removes a face label, so a hub of face labels is told so instead);
 *  - merge the other way round — only when THAT merge fits the bound, which the refusal knows because it counted it;
 *  - never "move".
 *
 * The door test (`a-refused-merge-answers-alike-on-every-door-db.test.js`) holds the same refusal on every door through
 * a real store; this file holds the rows of the truth table a store fixture would make slow to reach.
 *
 * Run: node --test testing/standalone/a-too-large-merge-refusal-says-what-the-reader-can-do.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { MergeTooLarge } = await import('../../server/dist/brain/merge.js');

const SURVIVOR = { _id: 'id-north', name: 'North Hub' };
const ABSORBED = { _id: 'id-south', name: 'South Hub' };
const BOUND = 100;

/** A refusal over `BOUND` with these counts; `reverse` is what merging the other way round would relink. */
function refusal({ edges = 99, links = 1, faces = 1, reverse = BOUND + 50, survivor = SURVIVOR, absorbed = ABSORBED } = {}) {
  return new MergeTooLarge({ survivor, absorbed, spaceId: 'hubs', tally: { edges, links, faces }, bound: BOUND, reverseRelinks: reverse });
}

describe('a too-large merge refusal says what its reader can see or do', () => {
  it('names the absorbed entity and the survivor by name, in that order, with their ids after', () => {
    const msg = refusal().message;
    assert.match(msg, /'South Hub'[^]*\binto\b[^]*'North Hub'/, `the refusal does not name both entities in their roles: ${msg}`);
    for (const id of [ABSORBED._id, SURVIVOR._id]) assert.ok(msg.includes(id), `the refusal drops the id ${id} an API caller acts on: ${msg}`);
    assert.ok(msg.indexOf("'South Hub'") < msg.indexOf(ABSORBED._id), `a name must come before its id: ${msg}`);
  });

  it('states the count, what it is made of, the bound, and that nothing was written', () => {
    const msg = refusal({ edges: 97, links: 3, faces: 1 }).message;
    for (const n of [101, 97, 3, 1, BOUND]) assert.match(msg, new RegExp(`\\b${n}\\b`), `the refusal does not state ${n}: ${msg}`);
    assert.match(msg, /nothing was written/i, `the refusal does not say nothing was written: ${msg}`);
  });

  it('suggests deleting edges or links, and how many, when that brings the merge under the bound', () => {
    const msg = refusal({ edges: 140, links: 5, faces: 1 }).message;   // 146 relinks: 46 over
    assert.match(msg, /\bdelete at least 46\b/i, `the refusal does not say how many to delete: ${msg}`);
    assert.match(msg, /\bedges\b[^.]*\blinks\b/i, `the refusal does not say what to delete: ${msg}`);
  });

  it('does not suggest deleting edges or links when the face labels alone exceed the bound', () => {
    const msg = refusal({ edges: 5, links: 0, faces: BOUND + 10 }).message;
    assert.doesNotMatch(msg, /\bdelete at least\b/i, `deleting edges cannot bring this merge under the bound, but the refusal suggests it: ${msg}`);
    assert.match(msg, /face labels/i, `the refusal does not say what holds it over the bound: ${msg}`);
  });

  it('offers merging the other way round only when that merge fits the bound', () => {
    const fits = refusal({ reverse: 7 }).message;
    assert.match(fits, /other way round/i, `merging the other way round fits, and the refusal does not say so: ${fits}`);
    assert.match(fits, /\b7\b/, `the refusal does not say what the other direction relinks: ${fits}`);
    assert.match(fits, /keep[^.]*'South Hub'[^.]*absorb[^.]*'North Hub'/i, `the other direction is not stated by name: ${fits}`);
    for (const reverse of [BOUND + 1, BOUND + 500]) {
      const msg = refusal({ reverse }).message;
      assert.doesNotMatch(msg, /other way round/i, `the other direction relinks ${reverse}, over the bound, and is offered: ${msg}`);
    }
    assert.match(refusal({ reverse: BOUND }).message, /other way round/i, 'a merge of exactly the bound runs, so it must be offered');
  });

  it('a count stopped at bound + 1 is said as "more than the bound", never as a number or a deletion count (bundle-30 I8)', () => {
    // The tally counts each kind with a limit of bound + 1, so a hub is refused without reading all of it.
    const msg = refusal({ edges: BOUND + 1, links: 2, faces: 0 }).message;
    assert.match(msg, new RegExp(`relink more than ${BOUND} records`), `a capped total is stated as a count: ${msg}`);
    assert.match(msg, new RegExp(`edges \\(more than ${BOUND}\\)`), `a capped kind is stated as a count: ${msg}`);
    assert.doesNotMatch(msg, /\bdelete at least\b/i, `a capped count cannot say how many to delete: ${msg}`);
    assert.match(msg, /\bedges\b[^.]*\blinks\b/i, `the refusal no longer says what to delete: ${msg}`);
  });

  it('never tells the reader to move an edge — no door can', () => {
    for (const c of [{}, { reverse: 0 }, { edges: 0, links: 0, faces: BOUND + 1 }, { edges: 3, faces: BOUND, reverse: 1 }]) {
      const msg = refusal(c).message;
      assert.doesNotMatch(msg, /\bmov(e|ing)\b/i, `the refusal suggests moving: ${msg}`);
    }
  });

  it('keeps one line however the names are spelled', () => {
    const msg = refusal({ absorbed: { _id: 'id-x', name: 'Line one\nLine two' } }).message;
    assert.ok(!/[\r\n]/.test(msg), `a name's line break reached the refusal, which automerge logs as one line: ${JSON.stringify(msg)}`);
  });

  it('carries the structured fields unchanged: the code, the count and the bound', () => {
    const err = refusal({ edges: 97, links: 3, faces: 1 });
    assert.deepEqual(err.toStructured(), { code: 'merge_too_large', relinks: 101, bound: BOUND });
    assert.match(err.message, /^merge_too_large: /, 'the message starts with the code, as every door has shown it');
  });
});
