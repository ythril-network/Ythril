/**
 * A tracker item's `Verify:` line is checkable, and the check agrees with the shell it is written for.
 *
 * ## The failure this exists to prevent, measured rather than argued
 *
 * The obvious implementation matches the pattern literally. On this tree that silently disagrees with grep:
 *
 *     grep -c "^export" server/src/brain/edges.ts   → 24   what the author sees in Git Bash
 *     literal substring count                       →  0   what a naive matcher answers
 *
 * The divergence runs toward **0**, and `returns 0` is what every clause in the corpus asserts. So the gate
 * would report the evidence intact while the author, hand-checking the identical line in the shell it names,
 * sees 24 and believes the row carries real evidence. Both wrong, in the same direction, quietly.
 *
 * Interpreting the pattern as a regex instead is worse: `new RegExp` would hand an unreviewed string from a
 * gitignored file to V8's backtracking engine, which has no timeout in JavaScript — measured on this machine,
 * `new RegExp('(a+)+b').test('a'.repeat(40))` runs for **119 seconds**. So the pattern is REFUSED when it
 * contains a character grep would read as an operator, and the author rewrites it as a literal.
 *
 * ## The other direction matters just as much
 *
 * `( ) { } | + ?` are ORDINARY characters in a basic regular expression — grep only treats them as operators
 * when backslash-escaped, and the backslash is refused. Rejecting them would push authors toward vaguer
 * patterns, and a vaguer pattern matches a neighbour of its subject, which is the failure the whole check
 * exists to catch. Both directions are asserted below.
 *
 * ## What a green result MEANS
 *
 * "Its stated evidence still holds" — never "it is still open". They differ whenever a fix lands somewhere
 * other than the file the row names, which here is the usual shape, because the convention is to extract.
 *
 * Run: node --test testing/standalone/verify-line.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { verifyLineOf, parseVerifyLine, evaluateClause } from '../../scripts/verify-line.mjs';

/** A stand-in tree. `readLines` is injected, so this test touches no filesystem and no git. */
const TREE = {
  'server/src/brain/edges.ts': ['export const a = 1;', 'const b = 2;', 'export function c() {}'],
  'server/src/spaces/meta-update.ts': ['const merged = { ...meta };', 'return merged;'],
};
const ctx = {
  isTracked: p => Object.prototype.hasOwnProperty.call(TREE, p),
  readLines: p => TREE[p],
};

describe('the verify line is found and unwrapped', () => {
  it('reads the label with the colon INSIDE the bold', () => {
    // `**Verify:**`, which is what bolding the whole label produces. Anchoring on `**Verify**:` matched nothing
    // and reported every item in the folder unparseable.
    assert.equal(verifyLineOf('body\n\n**Verify:** still open while `grep -c "x" f.ts` returns 0.'),
      'still open while `grep -c "x" f.ts` returns 0.');
  });

  it('joins a clause the tracker hard-wrapped across two lines', () => {
    // Trackers wrap at 118 columns, so a real clause routinely splits with the integer on the second line.
    // Reading only the labelled line would report those unparseable for a formatting choice.
    const body = '**Verify:** still open while `grep -c "loadNodeDetails" client/src/app/x.ts`\nreturns 1.';
    assert.equal(verifyLineOf(body), 'still open while `grep -c "loadNodeDetails" client/src/app/x.ts` returns 1.');
  });

  it('stops at the blank line, not at the end of the item', () => {
    const body = '**Verify:** still open while `grep -c "x" f.ts` returns 0.\n\nA later paragraph about scope.';
    assert.doesNotMatch(verifyLineOf(body), /later paragraph/);
  });

  it('returns null when there is no verify line', () => {
    assert.equal(verifyLineOf('### S-1 — the field\nBody with no evidence.'), null);
  });
});

describe('a pattern grep would read as an operator is REFUSED, not guessed', () => {
  for (const [meta, pattern] of [['^', '^export'], ['$', 'export$'], ['.', 'a.b'], ['*', 'ab*'],
    ['[', 'a[bc]'], ['\\', 'reembed\\|embedStored']]) {
    it(`refuses \`${meta}\` and names it`, () => {
      const r = parseVerifyLine(`still open while \`grep -c "${pattern}" server/src/brain/edges.ts\` returns 0`);
      assert.equal(r.ok, false, `${pattern} must not be accepted — grep and a literal matcher disagree on it`);
      assert.match(r.reason, new RegExp(escapeRegExp(meta)));
    });
  }

  it('the refusal explains the direction of the disagreement', () => {
    // Naming the character is not enough — the author needs to know it silently reads as 0, which is what the
    // line asserts, or they will assume the check is being fussy and work around it.
    const r = parseVerifyLine('still open while `grep -c "^export" server/src/brain/edges.ts` returns 0');
    assert.match(r.reason, /toward 0/);
  });
});

describe('a pattern that is LITERAL in a basic regular expression is accepted', () => {
  // The over-strict direction. `( ) { } | + ?` are ordinary in a BRE, so grep and this check already agree —
  // refusing them would force vaguer patterns, and a vaguer pattern matches its subject's neighbours.
  for (const pattern of ['loadNodeDetails(entityId: string)', 'endpoints?:', 'a+b', 'x|y', 'f{2}']) {
    it(`accepts ${pattern}`, () => {
      const r = parseVerifyLine(`still open while \`grep -c "${pattern}" server/src/brain/edges.ts\` returns 0`);
      assert.equal(r.ok, true, `${pattern} means the same to grep and to a literal matcher`);
      assert.equal(r.pattern, pattern);
    });
  }
});

describe('the clause grammar', () => {
  it('takes the pattern, the path and the integer', () => {
    const r = parseVerifyLine('still open while `grep -c "uuidv5" server/src/brain/edges.ts` returns 0.');
    assert.deepEqual({ pattern: r.pattern, path: r.path, expected: r.expected },
      { pattern: 'uuidv5', path: 'server/src/brain/edges.ts', expected: 0 });
  });

  it('allows prose after the integer', () => {
    /*
     * S-1's tail is the ARGUMENT that its pattern is meaningful — "grep the declaration, not the word:
     * `endpoints` already appears four times about provider URLs". Refusing exactly the prose that justifies a
     * pattern would be backwards, and the clause is already complete before it.
     */
    const r = parseVerifyLine('still open while `grep -c "x" server/src/brain/edges.ts` returns 0 — because the '
      + 'plainer pattern reports this shipped and always would have.');
    assert.equal(r.ok, true);
    assert.equal(r.expected, 0);
  });

  it('accepts an unquoted single-word pattern, as the corpus writes it', () => {
    const r = parseVerifyLine('still open while `grep -c fromType server/src/brain/edges.ts` returns 0.');
    assert.equal(r.pattern, 'fromType');
  });

  it('refuses an unquoted pattern containing a space', () => {
    const r = parseVerifyLine('still open while `grep -c kind === chrono server/src/brain/edges.ts` returns 0');
    assert.equal(r.ok, false);
  });

  it('refuses a directory, because no grep produces a summed count for one', () => {
    // Real grep prints "Is a directory" and exits 2; `-rc` prints a count per file and never a sum. Answering a
    // sum would make this gate the sole oracle for its own integer, obtainable only by fitting it until green.
    const r = parseVerifyLine('still open while `grep -c "fromType" server/src/` returns 6');
    assert.equal(r.ok, false);
    assert.match(r.reason, /directory/);
  });

  it('recognises the MANUAL hatch', () => {
    assert.deepEqual(parseVerifyLine('MANUAL — re-run Tier 0-R; S0+ and S0 must converge.'),
      { ok: true, kind: 'manual' });
  });

  it('a prose line with no clause is unparseable, and the message quotes it', () => {
    const r = parseVerifyLine('the measured case — a space of memories must return graphNodes > 0 at depth 1');
    assert.equal(r.ok, false);
    assert.match(r.reason, /measured case/);
    assert.match(r.hint, /grep -c/);
  });
});

describe('evaluating a clause against the tree', () => {
  const clause = (pattern, path, expected) => ({ pattern, path, expected });

  it('holds when the count matches', () => {
    assert.deepEqual(evaluateClause(clause('export', 'server/src/brain/edges.ts', 2), ctx),
      { state: 'holds', actual: 2 });
  });

  it('disagrees when it does not, and reports what it actually saw', () => {
    const r = evaluateClause(clause('export', 'server/src/brain/edges.ts', 0), ctx);
    assert.equal(r.state, 'disagrees');
    assert.equal(r.actual, 2);
  });

  it('counts LINES, not matches, because that is what `grep -c` does', () => {
    // A line containing the pattern twice counts once. Getting this wrong makes every multi-hit line inflate
    // the number, and the author's shell would disagree.
    const twice = { isTracked: () => true, readLines: () => ['export export', 'plain'] };
    assert.equal(evaluateClause(clause('export', 'f.ts', 1), twice).actual, 1);
  });

  it('a path that is gone is BROKEN, never zero', () => {
    /*
     * The load-bearing case. If a missing file evaluated to 0 matches, then
     * `grep -c foo deleted.ts returns 0` would pass for ever from the moment the file was deleted — the same
     * hole this check exists to close, one layer further down.
     */
    const r = evaluateClause(clause('foo', 'server/src/gone.ts', 0), ctx);
    assert.equal(r.state, 'broken');
    assert.match(r.why, /not a tracked file/);
  });

  it('an untracked file that exists on disk is still BROKEN', () => {
    // Tracked-ness comes from git, never from the filesystem: `todo/` and `dist/` are gitignored, and evidence
    // that lives outside the repo cannot be checked on another machine.
    const onDiskOnly = { isTracked: () => false, readLines: () => ['export'] };
    assert.equal(evaluateClause(clause('export', 'server/dist/edges.js', 1), onDiskOnly).state, 'broken');
  });
});
