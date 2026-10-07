/**
 * Every ordering read of a file tombstone's position is capped by ONE function, `settledPositionCap` — so no page, and no
 * prune, can take a position that an earlier, uncommitted write may still land below (Q-346, bundle-71 D1, gate T6b).
 *
 * ## Why a gate, and why it is the position twin of the seq keyset's
 *
 * The hold that keeps a position from being acknowledged early is only a hold on whoever READS below it. The seq horizon
 * has one such reader family (`settledSeqRange`); the position's readers are the served page (`publishedFileTombstones`,
 * `publishedFileTombstonePage`, the legacy `since` read), the push's pages, and the prune. A reader added next year that
 * orders by `positionAt` and does not ask the cap is the defect again, silently: the hold is registered and honoured by
 * every other reader, and this one reads straight through it.
 *
 * ## What is derived, and the floor
 *
 * The readers are every top-level function of `server/src/files/tombstones.ts` (comments blanked) whose code COMPARES
 * `positionAt` to something in a query: a range operator on it (`positionAt: { $lt | $lte | $gt | $gte }`) or the shared keyset
 * (`isoKeysetFilters('positionAt', …)`). An equality, an existence test and a sort are not comparisons. Each must call
 * `settledPositionCap(`, and the module must define and export it. The floor is two readers (the page and the prune), because an
 * empty derivation passes every loop written over it.
 *
 * The rule is the call, not a site: a reader added to the module is held to it the day it is written, and one that bounds
 * itself by a hand-written clock read is exactly what this refuses. The scanner is itself shown to see both outcomes on a
 * fixture below, so a scan that finds nothing to refuse is told apart from one that was never able to.
 *
 * Run: node --test testing/standalone/a-file-tombstone-position-is-read-through-one-cap.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { topLevelFunctionSpans } from './_call-graph.mjs';

const OWNER = 'server/src/files/tombstones.ts';
const CAP = 'settledPositionCap';
/**
 * A comparison of the position in a query: a range operator on it, the shared keyset over it, or asking one of the module's two
 * position questions (`FILE_TOMBSTONE_QUERIES.cappedPage` / `.prunePage`), whose builders hold the keyset the readers run.
 */
const COMPARES_POSITION = /positionAt['"]?\s*:\s*\{\s*\$(?:lt|lte|gt|gte)\b|isoKeysetFilters\s*\(\s*['"]positionAt['"]|FILE_TOMBSTONE_QUERIES\s*\.\s*(?:cappedPage|prunePage)\s*\(/;

/** `{ readers, uncapped }`: the functions that compare `positionAt`, and those among them that never ask the cap. */
export function positionReaders(code) {
  const readers = [...topLevelFunctionSpans(code)].filter(([, span]) => COMPARES_POSITION.test(span.body)).map(([name]) => name);
  const bodies = new Map([...topLevelFunctionSpans(code)].map(([name, span]) => [name, span.body]));
  const uncapped = readers.filter(name => !new RegExp(`\\b${CAP}\\s*\\(`).test(bodies.get(name)));
  return { readers, uncapped };
}

describe('every ordering read of a file tombstone position is capped by one function', () => {
  const code = blankComments(readFileSync(join(REPO_ROOT, OWNER), 'utf8'));
  const { readers, uncapped } = positionReaders(code);

  it('the derivation finds the readers, so an empty set cannot pass', () => {
    assert.ok(readers.length >= 2, `only ${readers.length} reader(s) of the position found in ${OWNER} (${readers}) — the scan is broken`);
    assert.ok(readers.includes('pruneFileTombstonesUpTo'), 'the prune is not among the readers derived — re-anchor the scan');
  });

  it(`${OWNER} defines and exports ${CAP}, the one way a read is capped`, () => {
    // `ok` and not `match`: a failed `match` prints the whole module as its "actual".
    assert.ok(new RegExp(`export\\s+(?:async\\s+)?function\\s+${CAP}\\b`).test(code),
      `${OWNER} exports no ${CAP}: nothing caps a page or a prune below an open position hold, so an acknowledgement can cover a row that has not landed`);
  });

  it('every reader that compares positionAt asks it', () => {
    assert.deepEqual(uncapped, [],
      `these functions in ${OWNER} compare positionAt and never call ${CAP}(): ${uncapped.join(', ')} — a page or a prune that reads straight `
      + 'through an open position hold can acknowledge, and then remove, a tombstone whose write has not yet landed');
  });

  it('the scan tells a capped module from an uncapped one (it can see both outcomes)', () => {
    // Top-level, as the module's functions are: the scan reads declarations from the start of a line.
    const capped = [
      `async function page(s) { const cap = await ${CAP}(s); return find({ positionAt: { $lt: cap } }); }`,
      `async function prune(s, upTo) { const cap = await ${CAP}(s); return del({ positionAt: { $lte: upTo, $lt: cap } }); }`,
      'async function legacy(s) { return upd({ positionAt: { $exists: false } }); }',
    ].join('\n');
    assert.deepEqual(positionReaders(capped), { readers: ['page', 'prune'], uncapped: [] });
    const oneMissing = capped.replace(`const cap = await ${CAP}(s); return del(`, 'return del(');
    assert.deepEqual(positionReaders(oneMissing).uncapped, ['prune'], 'a reader that drops the cap is not seen');
    const keyset = `async function since(s) { const { tie, range } = isoKeysetFilters('positionAt', after); return tieThenRange(find, tie, range); }`;
    assert.deepEqual(positionReaders(keyset), { readers: ['since'], uncapped: ['since'] }, 'the shared keyset over positionAt is not a comparison to the scan');
    const asked = `async function page(s) { return ask(s, FILE_TOMBSTONE_QUERIES.cappedPage({ spaceId: s, after, cap: 'x' })); }\n`
      + `async function prune(s, upTo) { const cap = await ${CAP}(s); return ask(s, FILE_TOMBSTONE_QUERIES.prunePage({ after, cap, upTo })); }`;
    assert.deepEqual(positionReaders(asked), { readers: ['page', 'prune'], uncapped: ['page'] }, 'a reader that asks the position questions is not seen');
  });
});
