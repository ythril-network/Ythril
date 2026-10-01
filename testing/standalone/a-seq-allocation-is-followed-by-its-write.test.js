/**
 * In a create/converge writer, the first thing awaited after a seq is allocated is the write that carries it (`Q-196`).
 *
 * ## Why, now that a pull serves below the lowest uncommitted seq
 *
 * `a-pull-never-passes-an-uncommitted-seq-db.test.js` holds the correctness half: while a seq is allocated and its
 * write has not settled, no pull serves at or above it. That makes every await between allocation and write a
 * stall rather than a loss — and a stall for the WHOLE space: every peer's pull of every collection stops at the
 * held seq until the slowest writer finishes. Today three of the four create/converge writers allocate and then
 * await an embedding call (`embed`), a duplicate scan, a contradiction scan or an endpoint-name lookup before they
 * write, so the held window is a model round trip wide. Design v3 item 4 moves that work into planning, before
 * the allocation; this gate is what keeps it there.
 *
 * ## The rule
 *
 * **For every seq allocation in the create/converge writers — `saveFact`, `upsertEntity`, `createChrono`,
 * `upsertEdge`, and every module under `server/src/brain/write-plan/` once it exists — the next `await` in the
 * source after the allocation is a record write** (`insertOne`/`insertMany`/`updateOne`/`updateMany`/
 * `replaceOne`/`bulkWrite`). An allocation is `await nextSeq(` or `await withAllocatedSeqs(` — for the latter the
 * next await is the first inside the write callback, which is the same question asked of the block form.
 *
 * Read textually, not per control path: a branch whose write comes later in the source than another branch's is
 * judged by the first one. That errs toward PASSING an interleaved converge/insert pair, never toward a false red,
 * and the four writers today each have one allocation ahead of both branches.
 *
 * Scope is the design's (item 1): update, delete, merge, rekey and redaction paths keep their own allocation and
 * are not judged here.
 *
 * Run: node --test testing/standalone/a-seq-allocation-is-followed-by-its-write.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementFrom } from './_structural-window.mjs';

/** The four create/converge doors. A fixture naming the design's scope; the sites inside them are derived. */
const WRITERS = [
  ['server/src/brain/fact.ts', 'saveFact'],
  ['server/src/brain/entities.ts', 'upsertEntity'],
  ['server/src/brain/chrono.ts', 'createChrono'],
  ['server/src/brain/edges.ts', 'upsertEdge'],
];
const WRITE_PLAN_DIR = 'server/src/brain/write-plan';

/** Every subject text: each writer's body, and each write-plan module whole. */
function subjects() {
  const out = WRITERS.map(([file, fn]) => ({
    where: `${file} ${fn}`,
    text: bodyOf(stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')), fn, `${file} ${fn}`),
  }));
  for (const { file, text } of readTrackedSources(WRITE_PLAN_DIR, { ext: ['.ts'], floor: 0, specs: false })) {
    out.push({ where: file, text: stripComments(text) });
  }
  return out;
}

/** Each allocation in a subject, with the statement of the next `await` after it. */
function allocationSites() {
  const sites = [];
  for (const { where, text } of subjects()) {
    for (const m of text.matchAll(/await\s+(?:nextSeq|withAllocatedSeqs)\s*\(/g)) {
      const after = m.index + m[0].length;
      const next = /\bawait\b/g;
      next.lastIndex = after;
      const hit = next.exec(text);
      const line = text.slice(0, m.index).split('\n').length;
      sites.push({
        where: `${where} (allocation on body line ${line})`,
        nextAwait: hit ? statementFrom(text, hit.index, where).replace(/\s+/g, ' ').slice(0, 160) : '(none)',
      });
    }
  }
  return sites;
}

const IS_RECORD_WRITE = /\.(?:insertOne|insertMany|updateOne|updateMany|replaceOne|bulkWrite)\s*(?:<[^>]*>)?\s*\(/;

describe('a seq allocation is followed by its write', () => {
  it('the sweep finds the allocations, so an empty set cannot pass', () => {
    const sites = allocationSites();
    assert.ok(sites.length >= 1, 'no seq allocation found in the create/converge writers — the sweep is broken, '
      + 'or the allocation moved somewhere this gate does not read');
  });

  it('in every create/converge writer, nothing is awaited between allocating a seq and writing it', () => {
    const bad = allocationSites().filter(s => !IS_RECORD_WRITE.test(s.nextAwait));
    assert.deepEqual(bad.map(s => `${s.where}: next await is \`${s.nextAwait}\``), [],
      'an await between the allocation and the write holds every peer\'s pull of this space below the allocated '
      + 'seq for as long as it takes. Do the embedding, duplicate and contradiction work in planning, before the '
      + 'allocation, and let the write be the first thing awaited after it.');
  });
});
