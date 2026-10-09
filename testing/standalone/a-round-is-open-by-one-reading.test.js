/**
 * "Is this vote round open, and when did it close" is ONE question with one answer, `networks/round-state.ts`.
 *
 * ## The defect this holds
 *
 * A round past its deadline stayed `concluded: false` until a cast, a peer relay or a gossip pass happened to touch it,
 * so every reader that meant "open for votes" and wrote `!round.concluded` listed it as open, accepted a cast on it
 * and counted it in the space chip. Seven readers asked the question in seven spellings, and two parsed the deadline
 * themselves. The rule now lives in `round-state.ts`: `roundPastDeadline` (an unparseable deadline counts as PAST —
 * a round nobody can date cannot stay open), `roundIsOpen`, and `roundClosedRefusal` (the one 404 / 409 both doors
 * and the peer relay answer with).
 *
 * ## What each part holds
 *
 * - the truth tables of the three functions, over every state a round can be in;
 * - every `!<round>.concluded` read in `server/src`, DERIVED from the tree, is either a named different question
 *   (a reason per file, each held true) or has become `roundIsOpen`; the readers the design names use it;
 * - no file but the module parses a round's deadline (the predicate that finds one is itself shown to fire).
 *
 * The boundary: a round is open AT its deadline instant and closed after it — the rule `isRoundPrunable` and the old
 * `new Date(deadline) < new Date()` both had, so no round changes state at a different instant than it did.
 *
 * Run: node --test testing/standalone/a-round-is-open-by-one-reading.test.js  (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const MODULE = 'server/src/networks/round-state.ts';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const round = (over = {}) => ({ roundId: 'r', type: 'remove', concluded: false, deadline: iso(NOW + 3_600_000), votes: [], ...over });
const state = () => import('../../server/dist/networks/round-state.js');

describe('roundPastDeadline: a deadline in the past closes the round, an undatable one counts as past', () => {
  const cases = [
    ['an hour ahead', iso(NOW + 3_600_000), false],
    ['a millisecond ahead', iso(NOW + 1), false],
    ['exactly now — a round is open AT its deadline instant', iso(NOW), false],
    ['a millisecond ago', iso(NOW - 1), true],
    ['an hour ago', iso(NOW - 3_600_000), true],
    ['empty text', '', true],
    ['not a date', 'not-a-date', true],
    ['an impossible date', '2026-13-45T99:00:00Z', true],
    ['absent', undefined, true],
    ['null', null, true],
  ];
  for (const [what, deadline, past] of cases) {
    it(`${what}: ${past ? 'past' : 'not past'}`, async () => {
      const { roundPastDeadline } = await state();
      assert.equal(roundPastDeadline(round({ deadline }), NOW), past);
    });
  }
  it('answers from the `now` it is given, never the clock', async () => {
    const { roundPastDeadline } = await state();
    const farFuture = round({ deadline: '2099-01-01T00:00:00.000Z' });
    assert.equal(roundPastDeadline(farFuture, NOW), false);
    assert.equal(roundPastDeadline(farFuture, Date.parse('2100-01-01T00:00:00.000Z')), true, 'the clock, not `now`, was read');
  });
});

describe('roundIsOpen: open means not concluded AND not past its deadline', () => {
  for (const concluded of [false, true]) {
    for (const past of [false, true]) {
      it(`concluded ${concluded}, past deadline ${past}: ${!concluded && !past ? 'open' : 'closed'}`, async () => {
        const { roundIsOpen } = await state();
        const r = round({ concluded, deadline: iso(NOW + (past ? -60_000 : 60_000)) });
        assert.equal(roundIsOpen(r, NOW), !concluded && !past);
      });
    }
  }
  it('a round with no `concluded` key reads as not concluded (a peer-adopted copy carries none)', async () => {
    const { roundIsOpen } = await state();
    const r = round(); delete r.concluded;
    assert.equal(roundIsOpen(r, NOW), true);
  });
  it('an undatable deadline is closed, so it cannot be listed or voted on for ever', async () => {
    const { roundIsOpen } = await state();
    assert.equal(roundIsOpen(round({ deadline: 'whenever' }), NOW), false);
  });
});

describe('roundClosedRefusal: one refusal for the operator act, the MCP tool and the peer relay', () => {
  it('an open round is not refused', async () => {
    const { roundClosedRefusal } = await state();
    assert.equal(roundClosedRefusal(round(), NOW), null);
  });
  it('a concluded round is 404 with the one sentence both doors have always used', async () => {
    const { roundClosedRefusal } = await state();
    for (const deadline of [iso(NOW + 3_600_000), iso(NOW - 3_600_000)]) {
      const r = roundClosedRefusal(round({ concluded: true, deadline }), NOW);
      assert.equal(r?.status, 404);
      assert.equal(r?.error, 'Round not found or already concluded');
    }
  });
  it('a round still open on paper but past its deadline is 409 round_expired and names the deadline', async () => {
    const { roundClosedRefusal } = await state();
    const deadline = iso(NOW - 3_600_000);
    const r = roundClosedRefusal(round({ deadline }), NOW);
    assert.equal(r?.status, 409);
    assert.equal(r?.code, 'round_expired');
    assert.equal(r?.deadline, deadline, 'the body carries the deadline so the client formats it in the viewer\'s own style');
    assert.ok(r?.error.includes(deadline), `the sentence does not say when voting closed: ${r?.error}`);
    assert.match(r.error, /^Voting on this round closed at /);
  });
  it('an undatable deadline is refused too (it is past), never let through', async () => {
    const { roundClosedRefusal } = await state();
    const r = roundClosedRefusal(round({ deadline: 'whenever' }), NOW);
    assert.ok(r && (r.status === 404 || r.status === 409), `an undatable round was not refused: ${JSON.stringify(r)}`);
  });
  it('agrees with roundIsOpen on every state: refused exactly when not open', async () => {
    const { roundClosedRefusal, roundIsOpen } = await state();
    for (const concluded of [false, true]) {
      for (const deadline of [iso(NOW + 1), iso(NOW), iso(NOW - 1), 'junk', undefined]) {
        const r = round({ concluded, deadline });
        assert.equal(roundClosedRefusal(r, NOW) === null, roundIsOpen(r, NOW), `disagreement for ${JSON.stringify({ concluded, deadline })}`);
      }
    }
  });
});

// ── The derived gates ────────────────────────────────────────────────────────────────────────────────────────────

const sources = () => trackedSources('server/src', { untracked: true, floor: 100 })
  .map(f => ({ file: f, code: stripComments(fs.readFileSync(f, 'utf8')) }));

/** `!round.concluded`, `!r.concluded`, `!net.pendingRounds[i].concluded` — the negated read: the question "is it still undecided". */
const NEGATED_CONCLUDED = /!\s*[\w$]+(?:\s*\??\.\s*[\w$]+|\[[^\]]*\])*\s*\??\.\s*concluded\b/g;
const negatedReads = (code) => [...code.matchAll(NEGATED_CONCLUDED)].length;

/**
 * Files whose negated `.concluded` read is a DIFFERENT question from "open for votes". Each is held: the file must still
 * hold such a read (a row outliving the code fails), and the reason is the reviewable half.
 */
const NOT_THE_OPEN_QUESTION = {
  'server/src/spaces/apply-wipe-round.ts': 'asks whether a space round has been decided and passed, to act on its outcome',
  'server/src/networks/member-introductions.ts': 'asks whether a join round concluded and passed, to admit or introduce its subject',
  'server/src/networks/network-spaces.ts': 'asks whether a space_addition round concluded and passed, to apply it',
  'server/src/auth/tokens.ts': 'asks whether a round still names a pending member, so a credential someone may still need is not revoked',
  'server/src/sync/engine.ts': 'the post-merge pass asks which rounds are still undecided, to conclude them; the merge itself uses roundIsOpen',
};

/** The readers the design names as meaning "open for votes". */
const OPEN_READERS = [
  'server/src/networks/vote-acts.ts',
  'server/src/networks/network-acts.ts',
  'server/src/spaces/network-status.ts',
  'server/src/networks/member-acts.ts',
  'server/src/sync/engine.ts',
  'server/src/api/sync/votes.ts',
];

describe('every reader of "open for votes" asks roundIsOpen', () => {
  const all = sources();

  it('reads a tree worth reading, and the module exists', () => {
    assert.ok(all.length >= 100, `only ${all.length} source files`);
    assert.ok(all.some(s => s.file === MODULE), `${MODULE} does not exist — the rule has no home`);
  });

  it('no negated `.concluded` read is left outside a named different question', () => {
    const left = all
      .filter(s => s.file !== MODULE && !(s.file in NOT_THE_OPEN_QUESTION) && negatedReads(s.code) > 0)
      .map(s => `${s.file} (${negatedReads(s.code)})`);
    assert.deepEqual(left, [],
      'these still ask `!round.concluded` to mean "open", which lists a round past its deadline as open until something touches it. '
      + 'Use roundIsOpen(round, now) from networks/round-state.ts, or, if the file asks a different question, name it in NOT_THE_OPEN_QUESTION with the reason.');
  });

  it('every named different question still exists (a row cannot outlive its code)', () => {
    const stale = Object.keys(NOT_THE_OPEN_QUESTION).filter(f => !all.some(s => s.file === f && negatedReads(s.code) > 0));
    assert.deepEqual(stale, [], `these rows excuse a read that is gone: ${stale.join(', ')}`);
  });

  for (const file of OPEN_READERS) {
    it(`${file} asks roundIsOpen`, () => {
      const src = all.find(s => s.file === file);
      assert.ok(src, `${file} is gone — re-point this gate`);
      assert.match(src.code, /\broundIsOpen\s*\(/, `${file} still decides "open" by its own reading`);
    });
  }

  it('the gossip merge skips a round that is not open, not only one that is concluded', () => {
    const engine = all.find(s => s.file === 'server/src/sync/engine.ts');
    const merge = bodyOf(engine.code, 'propagateVotesWithPeer', 'the gossip vote merge');
    assert.doesNotMatch(merge, /\blocal\s*\.\s*concluded\b/, 'the merge still tests `local.concluded`, so a past-deadline round keeps taking casts');
    assert.match(merge, /roundIsOpen\s*\(\s*local\b/);
  });
});

describe('no file but the module parses a round\'s deadline', () => {
  /** A time parse or comparison of a `.deadline`: `new Date(x.deadline)`, `Date.parse(x.deadline)`, `x.deadline < now`. A COPY (`deadline: r.deadline`) is not one. */
  const READS_A_DEADLINE = [
    /(?:new\s+Date|Date\.parse)\s*\(\s*[^()]*\bdeadline\b/,
    /\.deadline\s*[<>]=?[^=]/,
    /[^=]=?[<>]\s*[\w$.?]+\.deadline\b/,
  ];
  const readsDeadline = (code) => READS_A_DEADLINE.some(re => re.test(code));

  it('the predicate fires on the spellings that were there, and not on a copy', () => {
    for (const bad of ['const past = new Date(round.deadline) < new Date();', 'return Boolean(round.concluded) && new Date(round.deadline).getTime() < now;',
      'if (Date.parse(r.deadline) > now) {}', 'if (r.deadline < iso) {}']) {
      assert.ok(readsDeadline(bad), `the predicate misses: ${bad}`);
    }
    for (const fine of ['{ deadline: round.deadline, openedAt }', 'const d = { ...round, deadline: round.deadline };', 'deadline: new Date(Date.now() + hours * 3_600_000).toISOString(),']) {
      assert.ok(!readsDeadline(fine), `the predicate fires on a copy or a construction: ${fine}`);
    }
  });

  it('server/src has none outside networks/round-state.ts', () => {
    const files = sources().filter(s => /\bpendingRounds\b|\bVoteRound\b|\bround\b/.test(s.code));
    assert.ok(files.length >= 10, `only ${files.length} files mention rounds`);
    const offenders = files.filter(s => s.file !== MODULE && readsDeadline(s.code)).map(s => s.file);
    assert.deepEqual(offenders, [], 'these parse a round\'s deadline themselves — a second implementation of the rule, which is how an unparseable one stayed open. Ask roundPastDeadline / roundIsOpen.');
  });
});
