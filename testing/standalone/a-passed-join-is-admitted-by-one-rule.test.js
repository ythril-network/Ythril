/**
 * A passed join round adds its joiner to the member list through ONE rule, `admitPassedJoin`
 * (`server/src/networks/admit-passed-join.ts`).
 *
 * ## Why
 *
 * The rule had three hand-written copies — the local vote, the peer vote relay and the gossip pull — and the local
 * vote's copy dropped the credential guard: it admitted a joiner from a gossip round copy, whose `tokenHash` is
 * stripped, so the member could never authenticate here. The guard is the line a copy leaves out, so no copy may
 * exist: every write of a round's `pendingMember` into a member list is in the rule's own module, or is the named
 * exemption below with its reason.
 *
 * ## Seen red
 *
 * Put the old inline block back into `api/sync/votes.ts` (a `members.push(round.pendingMember)`) and this fails
 * naming that file; restored by hand.
 *
 * Run: node --test testing/standalone/a-passed-join-is-admitted-by-one-rule.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const RULE = 'server/src/networks/admit-passed-join.ts';

/**
 * Not a conclusion site: the joiner's own retry of a passed round (`POST .../join` after a crash between conclusion
 * and save). The caller has just proved the invite key, so it IS the credential holder — the question the guard asks
 * is already answered there.
 */
const EXEMPT = { 'server/src/networks/member-acts.ts': 'the joiner re-presents its invite key for a passed round' };

const sources = readTrackedSources('server/src', { floor: 200, specs: false, untracked: true })
  .map(s => ({ ...s, code: stripComments(s.text) }));

describe('a passed join is admitted by one rule', () => {
  it('the rule exists and admits only through the credential question', () => {
    const rule = sources.find(s => s.file === RULE);
    assert.ok(rule, `${RULE} is missing`);
    assert.match(rule.code, /tokenHash/, 'the rule no longer asks whether this instance holds the joiner\'s credential');
  });

  it('no other module pushes a round\'s pending member into a member list', () => {
    const offenders = sources
      .filter(s => s.file !== RULE && !(s.file in EXEMPT))
      .filter(s => /members\.push\(\s*(?:round\.)?pendingMember\b|members\.push\(\s*round\.pendingMember\b/.test(s.code))
      .map(s => s.file);
    assert.deepEqual(offenders, [], `a second copy of the join-admission rule: ${offenders.join(', ')}`);
  });

  it('every exemption still excuses something', () => {
    for (const file of Object.keys(EXEMPT)) {
      const s = sources.find(x => x.file === file);
      assert.ok(s && /members\.push\(\s*round\.pendingMember\b/.test(s.code),
        `${file} no longer pushes a pending member — drop its exemption`);
    }
  });

  it('each conclusion site calls the rule (floor: the three places a round concludes)', () => {
    const callers = sources.filter(s => s.file !== RULE && /\badmitPassedJoin\(/.test(s.code)).map(s => s.file);
    assert.ok(callers.length >= 3, `only ${callers.length} caller(s) of admitPassedJoin: ${callers.join(', ')}`);
  });
});
