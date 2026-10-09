/**
 * How a round ended is a READING for an operator, never an input to a decision — and what a peer wrote into a round is
 * never interpreted as markup.
 *
 * ## Why the outcome is read by no decision
 *
 * `outcome` is this instance's own label (`passed` | `vetoed` | `expired`, or `ended` for a round concluded before the label
 * existed). It is local state, it is not signed, and an old round has none. A decision that read it would act on a label rather
 * than on the casts, which is how an `expired` that was really a veto, or a missing one, would change what a space does. The
 * readers are the log that holds it and the door that shows it; every decision keeps reading `passed` and the votes.
 *
 * ## Why no vote surface sets HTML
 *
 * A round's `subjectLabel`, a space name and the summary of a proposal are written by PEERS. The vote row, the Recent
 * decisions list and the Overview panel print them as text (the summary wraps with `white-space: pre-line`); a `[innerHTML]`
 * or a `bypassSecurityTrust…` on any of them would turn a peer's label into the operator's markup.
 *
 * Both are DERIVED: the files that touch a round are found by what they mention, each rule is asserted over every one, and the
 * predicate that finds a violation is shown to fire.
 *
 * Run: node --test testing/standalone/a-round-outcome-decides-nothing-and-is-never-markup.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const serverFiles = () => trackedSources('server/src', { untracked: true, floor: 100 }).map(f => ({ file: f, code: stripComments(fs.readFileSync(f, 'utf8')) }));

/** A read of `.outcome` on a thing a round or an outcome entry is usually bound to; an assignment is a write. */
const READS_OUTCOME = /\b(?:round|rounds?\[[^\]]*\]|r|rd|pr|peerRound|local|stored|entry|e|o)\s*\??\.\s*outcome\b(?!\s*=[^=])/;

describe('what reads `outcome`', () => {
  it('the predicate fires on a read and not on a write or another object\'s outcome', () => {
    assert.ok(READS_OUTCOME.test("if (round.outcome === 'expired') {"));
    assert.ok(READS_OUTCOME.test("const label = r.outcome;"));
    assert.ok(!READS_OUTCOME.test("round.outcome = 'passed';"));
    assert.ok(!READS_OUTCOME.test("if (result.outcome === 'vote_pending') {"));
  });

  it('the conclusion writes it (the floor: a writer exists)', () => {
    const governance = serverFiles().find(f => f.file === 'server/src/sync/governance.ts');
    assert.match(governance.code, /\.outcome\s*=[^=]/, 'concludeRoundIfReady never assigns a round\'s outcome');
  });

  it('the conclusion never reads it back', () => {
    const governance = serverFiles().find(f => f.file === 'server/src/sync/governance.ts');
    const body = bodyOf(governance.code, 'concludeRoundIfReady', 'concludeRoundIfReady');
    assert.doesNotMatch(body, /\.outcome\b(?!\s*=[^=])/, 'the decision reads the label it is about to set');
  });

  it('no file that handles rounds reads it except the log and the door that shows it', () => {
    const READERS = ['server/src/networks/round-outcomes.ts', 'server/src/networks/vote-acts.ts'];
    const handlers = serverFiles().filter(f => /\bpendingRounds\b|\bVoteRound\b|\broundOutcomes\b/.test(f.code));
    assert.ok(handlers.length >= 10, `only ${handlers.length} files handle rounds`);
    const offenders = handlers.filter(f => !READERS.includes(f.file) && READS_OUTCOME.test(f.code)).map(f => f.file);
    assert.deepEqual(offenders, [], 'these read a round\'s outcome, so a decision could depend on a local, unsigned label');
  });
});

describe('what no vote surface does with a peer\'s text', () => {
  /** `innerHTML` as a property or a binding, and the escape hatches that turn text into trusted markup. */
  const SETS_MARKUP = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|bypassSecurityTrust\w*|\bDomSanitizer\b/;

  it('the predicate fires on each way of setting markup', () => {
    for (const bad of ['<p [innerHTML]="round.summary"></p>', 'el.innerHTML = label;', 'this.s.bypassSecurityTrustHtml(x)', 'private san: DomSanitizer']) {
      assert.ok(SETS_MARKUP.test(bad), `the predicate misses: ${bad}`);
    }
    assert.ok(!SETS_MARKUP.test('<p class="summary">{{ round.summary }}</p>'));
  });

  it('every client file that renders a round, an outcome or a summary of one prints it as text', () => {
    const files = trackedSources('client/src/app', { untracked: true, floor: 100 }).filter(f => !f.endsWith('.spec.ts') && !f.includes('/testing/'));
    const rounds = files.map(f => ({ file: f, text: stripComments(fs.readFileSync(f, 'utf8')) }))
      .filter(f => /\bpendingRounds\b|\bVoteRound\b|\bServerVoteRound\b|roundOutcomes|vote-outcomes|app-network-decisions|metaChangedFields/.test(f.text));
    assert.ok(rounds.length >= 3, `only ${rounds.length} client file(s) touch a round: ${rounds.map(r => r.file).join(', ')}`);
    const offenders = rounds.filter(f => SETS_MARKUP.test(f.text)).map(f => f.file);
    assert.deepEqual(offenders, [], 'these set markup in a file that renders what a peer wrote into a round');
  });
});
