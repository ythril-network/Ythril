/**
 * A seq that arrived from elsewhere is judged by ONE rule, in the arrival writer (`Q-107` part 1).
 *
 * ## The rule
 *
 * "Is this seq one the counter can carry" — a non-negative integer below the protocol's ingest ceiling — was
 * written three times: the batch push dropped and counted, the single routes answered 400 through their own
 * helper, and the pull skipped with a warning. Three copies of a guard that protects the counter is how one door
 * came to check only `z.number()` (the tombstone route). Now `arrivalRefusal` / `seqRefusal` in
 * `sync/arrivals.ts` are the rule, and every door asks them: the writer for records, the push accept before it
 * plans, the tombstone apply (`sync/tombstone-apply.ts`, both tombstone doors) for tombstones, the import for its
 * schema report.
 *
 * So the predicate underneath (`isSeqImplausible`) is called from its own module and the arrival writer, and
 * nowhere else in `server/src` — the call sites are derived from the sources, not listed, with a floor.
 *
 * Seen red by mutation, restored by hand: `isSeqImplausible(` called inline again in the tombstone route.
 *
 * Run: node --test testing/standalone/a-received-seq-is-checked-in-one-place.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = new Set(['server/src/util/seq.ts', 'server/src/sync/arrivals.ts']);
const SOURCES = readTrackedSources('server/src', { ext: ['.ts'], floor: 200, specs: false, untracked: true })
  .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), code: stripComments(text) }));

describe('a received seq is checked in one place', () => {
  it('the rule exists where this gate looks for it (floor)', () => {
    const arrivals = SOURCES.find(s => s.file === 'server/src/sync/arrivals.ts');
    assert.ok(arrivals, 'sync/arrivals.ts is gone — re-anchor this gate');
    assert.match(arrivals.code, /export function seqRefusal\(/, 'the shared seq rule is gone');
    assert.match(arrivals.code, /return seqRefusal\(seq, \{ optional: seqOptional \}\);/,
      'arrivalRefusal no longer judges the seq by seqRefusal');
  });

  it('no other module calls the seq predicate itself', () => {
    const elsewhere = SOURCES.filter(s => !HOME.has(s.file) && /\bisSeqImplausible\s*\(/.test(s.code)).map(s => s.file);
    assert.deepEqual(elsewhere, [],
      'a door judges a received seq with its own copy of the rule again. Ask arrivalRefusal (a record) or '
      + 'seqRefusal (anything else carrying a seq), so every door refuses the same seqs with the same words');
  });

  it('the tombstone route and the import ask the shared rule', () => {
    const of = (f) => SOURCES.find(s => s.file === f)?.code ?? '';
    // The tombstone rule moved out of the route into the one apply both tombstone doors share (bundle-46).
    assert.match(of('server/src/sync/tombstone-apply.ts'), /seqRefusal\(t\.seq, \{ optional: false \}\)/,
      'the tombstone apply no longer judges a tombstone seq by the shared rule');
    assert.match(of('server/src/api/admin-import.ts'), /arrivalRefusal\(doc, /,
      'the import\'s schema report no longer skips what the writer will refuse, by the writer\'s rule');
  });
});
