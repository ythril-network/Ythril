/**
 * There is ONE `ensureReindexed`, it lives in `testing/sync/helpers.js`, and it waits for the run to finish.
 *
 * ## The copies, and why their count is not written here
 *
 * Six integration files each defined their own `ensureReindexed`: POST reindex wherever `needsReindex` was set, and
 * go on without waiting. Q-99 part 2 makes a reindex a RUN that the embed queue finishes, so a fire-and-forget copy
 * now hands its suite a space whose recall is still refused — and the failure surfaces in whichever test recalls
 * first, nowhere near the cause. The fix is one helper that waits on `reindexRun.running`; the gate is that nobody
 * writes a seventh copy beside it.
 *
 * The set is DERIVED — every tracked or newly written `.js`/`.mjs` under `testing/` — with a floor, because a hand
 * list of six is the defect this file exists against arriving with a later expiry date.
 *
 * Run: node --test testing/standalone/one-ensure-reindexed-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = 'testing/sync/helpers.js';

const sources = () => readTrackedSources('testing', { ext: ['.js', '.mjs'], floor: 200, untracked: true })
  .map(s => ({ ...s, code: stripComments(s.text) }));

/** A local definition in any of the spellings a copy is written in. */
const DEFINES = /\b(?:async\s+)?function\s+ensureReindexed\s*\(|\b(?:const|let|var)\s+ensureReindexed\s*=/;

describe('one ensureReindexed', () => {
  it('the shared helper exists where the other stack helpers live', () => {
    const home = sources().find(s => s.file === HOME);
    assert.ok(home, `${HOME} is not in the listing`);
    assert.match(home.code, /export\s+async\s+function\s+ensureReindexed\s*\(/,
      `${HOME} must export ensureReindexed, so a suite imports it rather than writing its own`);
  });

  it('and it waits on the RUN, not on the flag', () => {
    const home = sources().find(s => s.file === HOME).code;
    const bodyOf = (name) => {
      const start = home.indexOf(`export async function ${name}(`);
      assert.ok(start >= 0, `${HOME} must export ${name}`);
      const next = home.indexOf('\nexport ', start + 1);
      return home.slice(start, next < 0 ? undefined : next);
    };
    assert.match(bodyOf('ensureReindexed'), /waitForReindexRunEnd\(/,
      'it must WAIT for each run to end; a copy that posts and returns is the defect this replaces');
    const wait = bodyOf('waitForReindexRunEnd');
    assert.match(wait, /reindex-status/, 'the wait must read the status route');
    assert.match(wait, /\.reindexRun\??\.running/,
      'it must poll reindexRun.running — needsReindex is cleared at the end of a run, but a run can exist without it');
    assert.match(wait, /waitFor\(/, 'and poll it, rather than read it once');
  });

  it('no other file under testing/ defines its own copy', () => {
    const copies = sources().filter(s => s.file !== HOME && DEFINES.test(s.code)).map(s => s.file);
    assert.deepEqual(copies, [],
      `these files define their own ensureReindexed; import it from ${HOME} instead:\n  ${copies.join('\n  ')}`);
  });
});
