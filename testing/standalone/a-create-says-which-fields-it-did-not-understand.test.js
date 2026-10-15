/**
 * A create says which of the fields you sent it did not understand — and there is ONE place that says so (Q-320, bundle-128).
 *
 * ## What this file used to hold, and where each case went
 *
 * It tested `unknownFieldWarnings` and the per-route `*_CREATE_BODY_KEYS` lists in `api/brain/unknown-fields.ts`: a REPORTER that
 * every create route called with a hand-kept list of the keys it read. Bundle-128 deletes that module. The accepted set is now
 * `acceptedWriteKeys(operation)`, derived from the paired MCP tool's schema, and the answer is made by one judge that both doors
 * call (design-v3 2). Each case below was deleted because the rule it held moved; the line says which file now holds its failure.
 *
 *  - "the reporter is reachable" -> the-unknown-write-field-judge-answers-by-outcome-and-stays-bounded.test.js (the judge's own export).
 *  - "an invented field is named, with what it accepts instead" -> an-unknown-field-is-answered-alike-on-both-doors-db.test.js, case (e)
 *    (row wording by outcome, the accepted list once per answer).
 *  - "a body of only known fields warns about nothing" -> an-unknown-field-is-answered-alike-on-both-doors-db.test.js, case (a)'s
 *    control (a known-field write carries no unknown row).
 *  - "the shared write options are known everywhere" -> a-route-reads-what-its-tool-declares.test.js. They are NOT known everywhere
 *    any more: an option is accepted where its route reads it and unknown where it does not (Q-494), which that gate derives.
 *  - "several unknown fields are all named, not just the first" -> an-unknown-field-is-answered-alike-on-both-doors-db.test.js, case (m)
 *    (ten rowed, then the `(+N more)` row).
 *  - "a non-object body is not an unknown field" -> the-unknown-write-field-judge-answers-by-outcome-and-stays-bounded.test.js (the
 *    judge is total: a body that is not a plain object judges nothing).
 *  - "every create route calls the reporter" -> a-route-judges-before-it-checks-the-body.test.js (every route calls the judge once,
 *    in order).
 *  - "the known-key list is not a second copy of the destructure" -> a-route-reads-what-its-tool-declares.test.js (what a route reads
 *    equals what its tool declares, derived, so there is no list to drift).
 *
 * ## What it asserts now
 *
 * The thing those cases were guarding was that no hand-kept list of accepted keys exists to drift from what a route reads. The
 * list, its reporter and the shared-options array are the second copy of what `acceptedWriteKeys` derives, so the surviving rule is
 * that they are GONE: no module, no `*_CREATE_BODY_KEYS` or `*_UPDATE_BODY_KEYS` declaration, no `SHARED_WRITE_BODY_KEYS`, no call
 * of `unknownFieldWarnings` anywhere in the server.
 *
 * Seen red on the unchanged base: all of them are still there.
 *
 * Run: node --test testing/standalone/a-create-says-which-fields-it-did-not-understand.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

describe('no hand-kept list of the keys a write accepts, and no reporter over one, is left', () => {
  const sources = trackedSources(['server/src'], { floor: 100 });

  it('api/brain/unknown-fields.ts is gone', () => {
    assert.equal(sources.includes('server/src/api/brain/unknown-fields.ts'), false,
      'the reporter module still exists: its lists are the second copy of what acceptedWriteKeys derives (design-v3 2.3)');
  });

  it('no source declares a *_CREATE_BODY_KEYS, *_UPDATE_BODY_KEYS or SHARED_WRITE_BODY_KEYS list, or calls the reporter', () => {
    const offenders = [];
    for (const f of sources) {
      const s = stripComments(readFileSync(f, 'utf8'));
      for (const m of s.matchAll(/\b([A-Z]+_(?:CREATE|UPDATE)_BODY_KEYS|SHARED_WRITE_BODY_KEYS)\b/g)) offenders.push(`${f}: ${m[1]}`);
      if (/\bunknownFieldWarnings\s*\(/.test(s)) offenders.push(`${f}: unknownFieldWarnings(`);
    }
    assert.deepEqual([...new Set(offenders)].sort(), [], 'a hand-kept accepted-key list, or its reporter, is still in use');
  });
});