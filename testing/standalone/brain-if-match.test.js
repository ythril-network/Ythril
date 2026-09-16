/**
 * `If-Match` preconditions on brain-record writes — the 412 path.
 *
 * `updateFact` and its three siblings read a record, await `nextSeq`, embed, then `$set` only the fields
 * the caller supplied. Two clients editing DIFFERENT fields both succeed and lose nothing; two editing the
 * SAME field means the loser's value disappears with a 200 and no trace. The counter shipped first, on the
 * owner's call to measure before building — this is the mechanism it was measuring for.
 *
 * ## What these tests are for
 *
 * Three things, and the middle one is the reason the other two are not enough on their own:
 *
 *  1. **The decision functions**, pinned directly. Parsing a header and choosing a metric label are pure and
 *     deserve to be tested as such.
 *  2. **That the precondition is enforced where it is ATOMIC.** The whole design rests on `seq` going into
 *     the `findOneAndUpdate` filter rather than being compared after the read. A comparison would pass every
 *     unit test here and still lose updates in production, because the read-to-write window contains an
 *     embedding call. So that placement is asserted on the source.
 *  3. **All four record types or none.** Shipping two would recreate the asymmetry this codebase keeps
 *     finding — one rule, two surfaces, the newer one weaker. The gate is "all four", not "at least one".
 *
 * Source-reading assertions strip comments first. A test written the obvious way passes on the comment that
 * explains the feature, and then the "fix" it invites is deleting the explanation.
 *
 * Run: node --test testing/standalone/brain-if-match.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { balancedFrom, blockAfter } from './_structural-window.mjs';

const ROOT = process.cwd();
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Code only — see the header. */
const withoutComments = (text) =>
  text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/** The four record types this feature is "all or none" across. */
const RECORDS = [
  { name: 'entities', route: 'server/src/api/brain/entities.ts', store: 'server/src/brain/entities.ts', update: 'updateEntityById' },
  { name: 'facts', route: 'server/src/api/brain/facts.ts', store: 'server/src/brain/fact.ts', update: 'updateFact' },
  { name: 'edges', route: 'server/src/api/brain/edges.ts', store: 'server/src/brain/edges.ts', update: 'updateEdgeById' },
  { name: 'chrono', route: 'server/src/api/brain/chrono.ts', store: 'server/src/brain/chrono.ts', update: 'updateChrono' },
];

let parseIfMatch, writeFilterFor, writeOutcome, ifMatchFromRequest, preconditionFailedBody;

before(async () => {
  ({ parseIfMatch } = await import('../../server/dist/util/if-match.js'));
  ({ writeFilterFor, writeOutcome } = await import('../../server/dist/brain/write-precondition.js'));
  ({ ifMatchFromRequest, preconditionFailedBody } = await import('../../server/dist/api/brain/_shared.js'));
});

describe('parsing the header', () => {
  it('an absent header is not a precondition', () => {
    // Opt-in by absence: making the header mandatory would break every existing client and script to
    // protect against a race most never hit.
    assert.deepEqual(parseIfMatch(undefined), { kind: 'none' });
  });

  it('accepts all three spellings of the same value', () => {
    // set-claim: the ETag spellings HTTP itself allows -- quoted, weak, bare, padded. An external grammar
    // this codebase parses rather than defines.
    // One rule, one parse. The bare form, the entity-tag form and the weak form are the same request, and
    // a surface that honoured only one of them would be a silently weaker surface.
    for (const spelling of ['41', '"41"', 'W/"41"', 'w/"41"', '  41  ']) {
      assert.deepEqual(parseIfMatch(spelling), { kind: 'exact', value: 41 }, `rejected ${spelling}`);
    }
  });

  it('treats `*` as "any existing record"', () => {
    assert.deepEqual(parseIfMatch('*'), { kind: 'any' });
  });

  it('rejects a value it cannot evaluate rather than ignoring it', () => {
    // The dangerous alternative is silence: a client that asked for a guarantee in terms the server cannot
    // read must not be told, with a 200, that the guarantee held.
    for (const bad of ['', '   ', 'abc', '4.5', '-1', '"4', '4-and-a-half']) {
      assert.equal(parseIfMatch(bad).kind, 'malformed', `accepted ${JSON.stringify(bad)}`);
    }
  });

  it('does not let parseInt-style leniency through', () => {
    // `parseInt('4-and-a-half')` is 4. Read leniently, a nonsense precondition becomes a passing one, which
    // is strictly worse than rejecting it.
    assert.equal(parseIfMatch('4-and-a-half').kind, 'malformed');
    assert.equal(Number.parseInt('4-and-a-half', 10), 4, 'the premise of this test has changed');
  });
});

describe('the request-level helper', () => {
  const reqWith = (v) => ({ get: (name) => (name === 'If-Match' ? v : undefined) });

  it('an absent header and `*` both mean "no constraint on the write"', () => {
    // Not the same as "no precondition asked for": `*` asks that the record exist, which the route has
    // already established by reading it. Neither becomes a `seq` in the write filter.
    assert.deepEqual(ifMatchFromRequest(reqWith(undefined)), { ok: true });
    assert.deepEqual(ifMatchFromRequest(reqWith('*')), { ok: true });
  });

  it('an exact value becomes the seq the write is conditioned on', () => {
    assert.deepEqual(ifMatchFromRequest(reqWith('W/"7"')), { ok: true, seq: 7 });
  });

  it('a malformed value comes back as an error naming the header', () => {
    const v = ifMatchFromRequest(reqWith('nonsense'));
    assert.equal(v.ok, false);
    assert.match(v.error, /If-Match/, 'the message does not name the header the client got wrong');
    assert.match(v.error, /nonsense/, 'the message does not quote what was received');
  });
});

describe('the precondition is enforced in the write filter', () => {
  it('no precondition leaves the filter exactly as it was', () => {
    // Every existing caller must be byte-for-byte unaffected. This is the assertion that says the feature
    // is opt-in at the storage layer and not only at the route.
    assert.deepEqual(writeFilterFor('abc'), { _id: 'abc' });
    assert.deepEqual(writeFilterFor('abc', undefined), { _id: 'abc' });
  });

  it('a precondition constrains the same write, not a separate read', () => {
    assert.deepEqual(writeFilterFor('abc', 12), { _id: 'abc', seq: 12 });
  });

  it('seq 0 is a real precondition and not an absent one', () => {
    // The falsy-zero trap. `if (ifMatchSeq)` would drop it and silently write unconditionally — the exact
    // false safety the whole feature exists to prevent, reachable only on the lowest-numbered record.
    assert.deepEqual(writeFilterFor('abc', 0), { _id: 'abc', seq: 0 });
  });

  it('every update function puts it in the filter of its own findOneAndUpdate', () => {
    // The design claim, asserted where it can fail: a comparison made after the read would pass every other
    // test in this file and still lose updates, because the read-to-write window contains an embed call.
    for (const r of RECORDS) {
      const code = withoutComments(src(r.store));
      assert.match(code, /findOneAndUpdate\(\s*\n?\s*asFilter<\w+>\(writeFilterFor\(/,
        `${r.name}: its update does not build the write filter from writeFilterFor, so the precondition is `
        + 'either absent or evaluated somewhere it is not atomic');
    }
  });

  it('every update function stops when the write matched nothing', () => {
    // All four build the response out of the record as READ. Without this guard a refused write returns a
    // fabricated 200 describing changes that were never made — which also means the 412 could never fire.
    for (const r of RECORDS) {
      const code = withoutComments(src(r.store));
      assert.match(code, /if \(!before(Write)?\) return null;/,
        `${r.name}: nothing stops the response being built from the pre-write read`);
    }
  });
});

describe('the metric keeps meaning what it meant', () => {
  it('a refused write is not counted as a collision', () => {
    // A collision is a lost update that HAPPENED; a refusal is one that did not. Folding them would also
    // corrupt the measurement the 412 work was prioritised on, since the collision series has been
    // accumulating since the counter shipped and would change meaning halfway through.
    assert.equal(writeOutcome(false, true, false), 'refused');
    assert.equal(writeOutcome(true, true, false), 'clean');
    assert.equal(writeOutcome(true, false, true), 'collision');
  });

  it('a vanished record with no precondition is not counted as clean', () => {
    // This was the pre-existing bug: `null` back from the write was labelled `clean`, so a record deleted
    // inside the window was recorded as a healthy write.
    assert.equal(writeOutcome(false, false, false), 'collision');
  });

  it('all three outcomes are pre-declared for all four collections', () => {
    // Absent and zero look identical in a graph and mean opposite things. `refused` staying absent until
    // the first refusal would read as "this instance cannot refuse", which is the opposite of the truth.
    const code = withoutComments(src('server/src/metrics/registry.ts'));
    assert.match(code, /for \(const outcome of \['clean', 'collision', 'refused'\]\)/,
      'the refused series is not pre-declared, so it reads as absent until the first refusal');
  });
});

describe('all four record types, or none', () => {
  it('every PATCH route reads the header before doing anything else', () => {
    for (const r of RECORDS) {
      const code = withoutComments(src(r.route));
      assert.match(code, /const ifMatch = ifMatchFromRequest\(req\);/,
        `${r.name}: its PATCH route never reads If-Match, so the header is silently ignored on this surface`);
      assert.match(code, /if \(!ifMatch\.ok\) \{ res\.status\(400\)/,
        `${r.name}: a malformed If-Match is not refused, so a client gets a 200 for a guarantee that was never evaluated`);
    }
  });

  it('every PATCH route hands the seq to its update function', () => {
    for (const r of RECORDS) {
      const code = withoutComments(src(r.route));
      // The update CALL, bounded by the paren that closes it — the seq is one of its arguments, so the
      // argument list is the subject and 400 characters was a guess at how long one gets.
      const at = code.indexOf(`${r.update}(`);
      assert.ok(at > -1, `${r.name}: ${r.update} is not called at all — re-anchor this gate`);
      assert.match(balancedFrom(code, at, `${r.update} call`), /ifMatch\.seq/,
        `${r.name}: the parsed precondition never reaches ${r.update}, so it is parsed and then dropped`);
    }
  });

  it('every PATCH route answers 412, and only when a precondition was given', () => {
    for (const r of RECORDS) {
      const code = withoutComments(src(r.route));
      // The branch, bounded by the brace that closes it.
      const at = code.indexOf('if (ifMatch.seq !== undefined');
      assert.ok(at > -1, `${r.name}: the precondition branch is gone — re-anchor this gate`);
      assert.match(blockAfter(code, at, 'the 412 branch'), /res\.status\(412\)/,
        `${r.name}: a refused write does not produce a 412`);
    }
  });

  it('file metadata REFUSES the header rather than ignoring it', () => {
    // The fifth PATCH on this router, and the one that would otherwise be discovered later. It has no `seq`
    // to condition a write on, so it cannot support the header — which makes saying so the whole job.
    const code = withoutComments(src('server/src/api/brain/file-meta.ts'));
    assert.match(code, /res\.status\(400\)\.json\(\{ error: '`If-Match` is not supported on file metadata/,
      'file metadata accepts and drops If-Match, answering 200 to a guarantee it never made');
  });

  it('the legacy POST-as-update is GONE, and its refusal went with it', () => {
    // Inverted in 3.0. While that form existed it had to REFUSE `If-Match`: it did no property validation
    // and wrote no audit snapshot, so it was deliberately not getting the capability, and accepting-then-
    // dropping the header would answer 200 to a guarantee it never made.
    //
    // The route is removed, so both halves must be absent together. A refusal message for a route that no
    // longer exists is dead text that reads like a live rule — and a returning route would arrive without
    // the refusal, which is the state this check exists to prevent.
    const code = withoutComments(src('server/src/api/brain/chrono.ts'));
    assert.ok(!/chronoRouter\.post\('\/spaces\/:spaceId\/chrono\/:id'/.test(code),
      'the legacy POST-as-update is back and must refuse If-Match, or be removed again');
    assert.ok(!/not supported on the legacy/.test(code),
      'a refusal for a route that does not exist is dead text');
    // The verb that DID get the capability still has it, so this is not passing on an empty file.
    assert.match(code, /chronoRouter\.patch\('\/spaces\/:spaceId\/chrono\/:id'/);
  });
});

describe('what the client is told', () => {
  it('a changed record hands back the current seq to retry with', () => {
    const body = preconditionFailedBody('entity', 42);
    assert.equal(body.currentSeq, 42);
    assert.match(body.error, /changed since you read it/);
  });

  it('a deleted record says so, and offers no token to retry with', () => {
    // Re-read at failure time, so an omitted `currentSeq` means the record is gone rather than unknown.
    const body = preconditionFailedBody('entity', undefined);
    assert.ok(!('currentSeq' in body), 'a token is offered for a record that no longer exists');
    assert.match(body.error, /deleted since you read it/);
  });

  it('names the record type, so a 412 from a batch says which write failed', () => {
    assert.match(preconditionFailedBody('chrono entry', 1).error, /chrono entry/);
  });

  it('never calls seq a version', () => {
    // `seq` is a per-SPACE monotonic counter, not a per-record version. Describing it as a version invites
    // a client to expect 1, 2, 3 for one record and to reason about the gaps.
    for (const body of [preconditionFailedBody('entity', 42), preconditionFailedBody('entity', undefined)]) {
      assert.doesNotMatch(body.error, /version/i, 'the message calls seq a version');
    }
  });
});
