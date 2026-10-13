/**
 * No server source asks the driver for a field's distinct values in one reply — it asks `distinctStringsOf` (bundle-44, preship).
 *
 * ## What the rule is
 *
 * The driver's `distinct` answers in ONE reply, and a reply is capped at 16 MB. Over a field a user's data fills (the files under a
 * directory, the files a link starts from) that is a ceiling the data can reach, and the act that asked (a directory move, an abandon,
 * a delete) fails with a size error. `db/distinct-strings.ts` reads the same answer as an aggregation's cursor. A call of `.distinct(`
 * anywhere under `server/src` is the next copy of the read it replaced: it is a finding, not a style note, and this gate has no
 * exemption list — a field whose values are few is still a read that should not need a reason.
 *
 * The subjects are derived: every tracked source under `server/src` (`trackedSources`, the floor inside it). Comments are blanked
 * first, so a docblock that names the driver's method (this module's own) is not a call.
 *
 * Seen red by a call written back into a source by hand. Run: node --test testing/standalone/no-source-reads-distinct-values-in-one-reply.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const DISTINCT_CALL = /\.distinct\s*[<(]/;
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

/** Every `{ file, line }` where `text` calls the driver's `distinct`. */
function callsIn(file, text) {
  const blanked = blankComments(text);
  return [...blanked.matchAll(new RegExp(DISTINCT_CALL, 'g'))].map(m => ({ file, line: lineOf(blanked, m.index) }));
}

describe('no server source reads distinct values in one reply', () => {
  it('the sources under server/src do not call the driver\'s distinct', () => {
    const files = trackedSources('server/src', { floor: 300 });
    const calls = files.flatMap(f => callsIn(f, readFileSync(f, 'utf8')));
    assert.deepEqual(calls, [], `these read distinct values in one reply (16 MB cap); use distinctStringsOf (db/distinct-strings.ts):\n  ${calls.map(c => `${c.file}:${c.line}`).join('\n  ')}`);
  });

  it('the scanner sees a call, a typed call and a call split over lines, and not a comment or a longer name', () => {
    assert.equal(callsIn('x.ts', 'await coll.distinct(\'a\', f);').length, 1);
    assert.equal(callsIn('x.ts', 'await coll.distinct<string>(\'a\', f);').length, 1);
    assert.equal(callsIn('x.ts', 'await coll\n  .distinct(\n    \'a\');').length, 1);
    assert.equal(callsIn('x.ts', '// coll.distinct(\'a\')\n/* .distinct( */').length, 0);
    assert.equal(callsIn('x.ts', 'await distinctStringsOf(coll, \'a\', f); x.distinctValues(1)').length, 0);
  });
});
