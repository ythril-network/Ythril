/**
 * The array-write recorder stamp is not inside a `try` that swallows somebody else's failure.
 *
 * ## What went wrong, twice, in the same place
 *
 * `B-13`: the conversion pre-flight clamps its `since` to when this instance began recording, so an
 * UNSTAMPED instance reports the full retention window over a recorder that had been running half an hour.
 * The canary operator saw a space of 270 chronos answer `count: 1`.
 *
 * The first fix moved `stampRecorderStart` out of `index.ts` and into
 * `startConfiguredInstanceServices`, because a first-run instance never reaches the boot path — the setup
 * route calls that function once the config is written. Correct, and not enough.
 *
 * **It landed as the LAST of six statements inside one `try` whose `catch` only logs.** An index creation
 * racing a Mongo still coming up — a flake this repository already has a memory of — skips every statement
 * after it, including the stamp, and reports it in a line nobody reads. The pre-flight then reports a
 * window it was not recording for, which is `B-13` arriving through a different door.
 *
 * Caught by CI on 2026-09-20, intermittently, on a change that touched no server code at all.
 *
 * ## Why the rule is about POSITION rather than about the stamp
 *
 * `stampRecorderStart` already protects itself: its body is a `try` that never throws, because failing to
 * record an observation about the observer must not take down a boot. Protecting it AGAIN would not have
 * helped — it was not its own failure that skipped it. What it needed was not to be downstream of five
 * unrelated things inside one net.
 *
 * So this asserts where the call sits, not what it does.
 *
 * Run: node --test testing/standalone/the-recorder-stamp-cannot-be-skipped-by-a-neighbour.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments } from './_strip-comments.mjs';

const SRC = 'server/src/bootstrap.ts';

/**
 * The source with comments blanked, through the SHARED stripper.
 *
 * A hand-rolled one stood here and `comment-strippers-are-ordered.test.js` refused it: it removed block
 * comments before line comments, so a block opener inside a `//` line starts a phantom block and swallows
 * real code. Not a style rule — it is the failure that makes a source-reading gate pass on the comment
 * explaining the thing it was meant to catch.
 *
 * `blankComments` keeps the line count, which matters here because every assertion below compares OFFSETS.
 */
const code = () => blankComments(readFileSync(SRC, 'utf8'));

/**
 * The phase-1 block, found by its CATCH rather than by counting characters after a `try`.
 *
 * A first draft sliced 260 characters past each block's closing brace looking for the catch message, and
 * `gates-bound-their-subject-structurally.test.js` refused it — rightly, and for a reason this file cannot
 * afford: a character window spans a different number of LINES on CRLF than on LF, so the gate would bound
 * a different region on Windows than in CI and could check less than it means to.
 *
 * The structural version needs no window at all. The catch is the one thing that identifies this block, so
 * find its message first and take the try that closes nearest before it.
 */
function phase1Block(src) {
  const marker = src.indexOf('Instance DB initialisation failed');
  if (marker < 0) return null;
  return tryBlocks(src).filter(b => b.end < marker).sort((a, b) => b.end - a.end)[0] ?? null;
}

/** The offsets of every `try {` and its matching `}` in the source, by brace counting. */
function tryBlocks(src) {
  const out = [];
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ start: m.index, end: i });
  }
  return out;
}

describe('where the recorder stamp sits', () => {
  it('the block finder sees a try block, and its end', () => {
    // Mutation-check the instrument before trusting it: a brace counter that never matches would report
    // "not inside any try" for a call that is inside one, which is this gate failing open.
    const sample = 'a();\ntry {\n  b();\n  if (x) { c(); }\n}\ncatch (e) { d(); }\ne();';
    const [b] = tryBlocks(sample);
    assert.ok(b, 'no try block found in a sample that has one');
    assert.ok(b.start < sample.indexOf('b()'), 'the block starts before its first statement');
    assert.ok(b.end < sample.indexOf('e()'), 'the block ends before the statement after it');
    assert.ok(b.end > sample.indexOf('c()'), 'a nested brace must not end the block early');
  });

  it('stampRecorderStart is called, and exactly once', () => {
    // The floor. Everything below is a position check, and a position check over nothing passes.
    const calls = [...code().matchAll(/await stampRecorderStart\(\)/g)];
    assert.equal(calls.length, 1,
      `expected one call to stampRecorderStart in ${SRC}, found ${calls.length}. If it moved, this gate is `
      + 'measuring nothing — point it at the new home deliberately.');
  });

  it('it is not inside the phase-1 initialisation block', () => {
    const src = code();
    const at = src.indexOf('await stampRecorderStart()');
    const phase1 = phase1Block(src);
    assert.ok(phase1,
      'the phase-1 try/catch is gone from bootstrap.ts — either it was renamed or the shape changed, and '
      + 'this gate cannot tell which. Decide, do not let it skip.');
    assert.ok(at < phase1.start || at > phase1.end,
      'stampRecorderStart is back inside the phase-1 try. Its catch only LOGS, so any earlier step failing '
      + '— an index creation racing a Mongo that is still coming up — skips the stamp in silence, and the '
      + 'conversion pre-flight then reports a window it was not recording for. That is `B-13` again.');
  });

  it('and nothing else was quietly moved out with it', () => {
    // The opposite mistake: "fixing" this by hoisting the whole block would put six real initialisations
    // outside the net that is deliberately around them, so a genuine DB failure would take the boot down.
    const src = code();
    const phase1 = phase1Block(src);
    const body = src.slice(phase1.start, phase1.end);
    for (const required of ['initAllSpaces', 'initAuditCollection', 'initWebhookDeliveryIndexes',
      'resetStaleWatermarksIfNeeded', 'ensureActivityIndexes']) {
      assert.ok(body.includes(required),
        `${required} is no longer inside the phase-1 net. Those failures MUST be tolerated — the workers `
        + 'retry and the next boot re-runs phase 1. Only the stamp belongs outside.');
    }
  });
});
