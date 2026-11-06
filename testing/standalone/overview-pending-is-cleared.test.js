/**
 * Every Overview panel that can show a first-load skeleton must clear its pending flag on BOTH outcomes.
 *
 * ## The failure this exists for
 *
 * The skeleton is keyed on a `pending` map rather than on the value being null, because null cannot say "not
 * yet": `tokenAccess` is null **permanently** for a non-admin (the endpoint 403s) and `completeness` is null
 * after a failure. A placeholder keyed on null alone would sit there forever in both cases.
 *
 * That makes the *clearing* load-bearing, and it happens in eight places — the success and failure handler of
 * each of four loaders. Drop one and a non-admin gets a permanent shimmer where a card should be, or a card that
 * failed to load never admits it. The page still works, nothing throws, and no unit test can see it: the
 * component spec renders the child with `pending` handed in, so it cannot know whether the parent ever lowers it.
 *
 * That is not a hypothetical — this gate exists because a mutation test proved it. Breaking `settled()` so it
 * never clears anything left the whole component spec green.
 *
 * Run: node --test testing/standalone/overview-pending-is-cleared.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockAfter } from './_structural-window.mjs';

const ROOT = process.cwd();
const BRAIN = 'client/src/app/pages/brain/brain.component.ts';
const OVERVIEW = 'client/src/app/pages/brain/overview-tab.component.ts';

// The loaders and their pending flags moved to `overview-data.service.ts` in the G-2 split; the shell still
// owns when a space switch happens. Both halves are the subject here, so both are read — a gate that followed
// only the shell would have gone quietly vacuous the moment the loaders left it, which is worse than the red
// it actually gave.
const DATA = 'client/src/app/pages/brain/overview-data.service.ts';
const src = [BRAIN, DATA].map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n');

/** The four panels, and the loader whose two handlers must clear each one. */
const PANELS = [
  { key: 'activity',     loader: 'loadSpaceActivity' },
  { key: 'completeness', loader: 'loadCompleteness' },
  { key: 'queue',        loader: 'loadEmbeddingQueue' },
  { key: 'tokens',       loader: 'loadTokenAccess' },
  // `stats` and `about` were here until 2026-08-08 and are deliberately gone, not overlooked. The owner
  // removed the statistics strip (the ER diagram shows the same counts with the structure intact) and the
  // Instance card (instance identity belongs to About, not to a space overview). Both loaders still run —
  // other views read their data — they simply no longer drive a skeleton on this tab, so a pending flag for
  // them would be one that is raised and never lowered, which is the exact defect this file exists to catch.
  //
  // `about` was also the reason `oneShot` existed: it was fetched once at init rather than per space switch.
  // No key needs that distinction now; the field is kept because the next one-shot panel will.
];

/** The body of one loader method, sliced to its own closing brace rather than a character count. */
function loaderBody(name) {
  // Not every loader is private: `loadStats` is called from four tab components' (mutated) outputs, and
  // `ngOnInit` is a lifecycle hook. Anchored on either modifier rather than assuming one, because assuming
  // `private` is what made this helper report "loadStats not found" for a method sitting in plain sight.
  let start = src.indexOf(`private ${name}(`);
  if (start < 0) start = src.indexOf(`\n  ${name}(`);
  assert.ok(start > 0, `${name} not found in ${BRAIN}`);
  const end = src.indexOf('\n  }', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return src.slice(start, end);
}

describe('an Overview skeleton can always be dismissed', () => {
  it('found the loaders — the pattern still matches', () => {
    for (const p of PANELS) assert.ok(loaderBody(p.loader).length > 60, `${p.loader} body looks empty`);
  });

  it('each loader clears its own pending flag, on success AND on failure', () => {
    const bad = [];
    for (const p of PANELS) {
      const body = loaderBody(p.loader);
      const clears = [...body.matchAll(new RegExp(`settled\\('${p.key}'\\)`, 'g'))].length;
      // At least one per handler. This used to demand EXACTLY two, and that is how the bug it was written to
      // prevent still shipped: `loadSpaceActivity` had its two — one in `next:`, one in `error:` — and two
      // early `return`s in between that reached neither. A space with no recorded usage showed its card
      // spinning for ever, and so did every space just after the usage reset.
      //
      // Counting calls answers "did somebody write a settle". The property is "does every PATH reach one",
      // which is what the early-return check below actually tests.
      if (clears < 2) bad.push(`${p.loader} clears '${p.key}' ${clears}x, expected at least 2 (next: + error:)`);
      if (!/error:/.test(body)) bad.push(`${p.loader} has no error handler at all`);

      // Every `return` inside the loader must have settled first. Looked for on the same line or the two
      // before it, which is how these are written — a settle further away than that is worth re-reading anyway.
      const lines = body.split('\n');
      lines.forEach((line, i) => {
        if (!/^\s*(\}\s*)?return;/.test(line) && !/\breturn;\s*\}/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        if (!near.includes(`settled('${p.key}')`)) {
          bad.push(`${p.loader} returns at line ${i + 1} of its body without settling '${p.key}' — that path `
            + 'leaves the skeleton up');
        }
      });
    }
    assert.deepEqual(bad, [], 'a pending flag that is never lowered is a skeleton that never goes away — and a '
      + `non-admin never gets tokenAccess at all:\n  ${bad.join('\n  ')}`);
  });

  it('pending is raised ONLY where the values are blanked', () => {
    // Raising it anywhere else would cover good data with a placeholder — the defect this whole change removes.
    //
    // Matched on `...p, activity: true` rather than on `overviewPending.set(`, because the raise legitimately
    // became an `update()`: `about` has a ONE-SHOT lifetime (fetched once at init, never re-fetched), so a
    // `set()` here would clobber it back to pending on every space switch and put a skeleton over data
    // already on screen. The invariant this test protects — raised in exactly ONE place, beside the blanks —
    // is unchanged; only the method is. Matching the method name made the test about the mechanism instead of
    // the guarantee.
    const raises = [...src.matchAll(/\.\.\.p, activity: true/g)].length;
    assert.equal(raises, 1, 'pending must be raised in exactly one place (selectSpace, beside the blanks)');

    // Anchored on the METHOD, not the first textual match — `selectSpace(` appears in the template first, and
    // slicing from there measured 19k characters of the wrong thing.
    // The blanks and the raise moved together into `blankForSpaceSwitch()` when the loaders left the shell
    // (G-2). The guarantee is unchanged and so is its shape — raised beside the blanks, in one place — so this
    // anchors on that method, and separately requires the space switch to still call it. Splitting the two is
    // what keeps "blanked on a switch" true rather than merely "blanked somewhere".
    // The METHOD, bounded by the brace that closes it. 2 000 characters was the largest cap in the suite and
    // the clearest sign of a guess: nobody chooses that number, they raise it until the test passes.
    // Every space switch runs `showSpace` since Q-701: `selectSpace` (the person's choice, which may first ask about an unsaved
    // draft) calls it, and so do the moves the page makes itself (a `?space=` link, a renamed or deleted view).
    const sel = src.indexOf('private showSpace(id: string): void {');
    assert.ok(sel > -1, 'showSpace is gone — re-anchor this gate');
    assert.match(src, /async selectSpace\(id: string\)[^{]*\{[\s\S]*?this\.showSpace\(id\)/, 'selectSpace must switch through showSpace');
    assert.match(blockAfter(src, sel, 'showSpace'), /this\.ov\.blankForSpaceSwitch\(\)/,
      'a space switch must still blank the panels, or the skeletons never go up in the first place');
    const at = src.indexOf('  blankForSpaceSwitch(): void {');
    assert.ok(at > 0, 'blankForSpaceSwitch method not found');
    const selectSpace = src.slice(at, src.indexOf('\n  }', at));
    for (const key of ['activity', 'completeness', 'queue', 'tokens']) {
      assert.match(selectSpace, new RegExp(`${key}: true`),
        `the space switch blanks ${key}, so it must raise its pending flag too`);
    }
    // And it must NOT raise `about`, whose data is not blanked by a space switch.
    assert.doesNotMatch(selectSpace, /about: true/,
      'about is fetched once at init, so raising it on a space switch would cover data already on screen');
  });
  it('`settled` really lowers the flag', () => {
    // The call-site checks above pass whether or not the function does anything, which a mutation test proved:
    // gutting the body left every one of them green.
    const at = src.indexOf('  private settled(');
    assert.ok(at > 0, 'settled() not found');
    const body = src.slice(at, src.indexOf('\n  }', at));
    assert.match(body, /overviewPending\.update\(/, 'settled() must actually lower the flag');
    assert.ok(!/if \(true\)/.test(body), 'settled() has been short-circuited');
  });

  it('the live-event refresh does NOT raise it', () => {
    // That path has good data on screen. A skeleton over it would be the original bug, arriving on a timer.
    // Anchored on the METHOD — `onLiveEvent(` is CALLED before it is declared, and slicing from the first
    // textual match measured the SSE handler instead, so this assertion passed against a deliberate break.
    const at = src.indexOf('  private onLiveEvent(');
    assert.ok(at > 0, 'onLiveEvent method not found');
    const live = src.slice(at, src.indexOf('\n  }', at));
    assert.ok(!/overviewPending/.test(live),
      'the live-event refresh must not raise pending — it would cover data already on screen');
  });

  it('every pending key has a skeleton branch, and every branch has a key', () => {
    // The two halves are written in different files, so a rename in one is invisible in the other.
    const ov = readFileSync(join(ROOT, OVERVIEW), 'utf8');
    for (const p of PANELS) {
      assert.match(ov, new RegExp(`@else if \\(pending\\(\\)\\.${p.key}\\)`),
        `no skeleton branch for '${p.key}' in ${OVERVIEW}`);
    }
    const branches = [...ov.matchAll(/@else if \(pending\(\)\.(\w+)\)/g)].map(m => m[1]).sort();
    assert.deepEqual(branches, PANELS.map(p => p.key).sort(),
      'the skeleton branches and the pending keys have drifted apart');
  });
});
