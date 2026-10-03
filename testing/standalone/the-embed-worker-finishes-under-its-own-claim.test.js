/**
 * Every place that CLAIMS a brain embed job finishes it under the claim it holds — the source half of `Q-249`
 * (5.6.3). The behaviour half is `an-embed-finish-under-a-taken-claim-matches-nothing-db.test.js`.
 *
 * ## Why a source gate as well
 *
 * `completeEmbedJob` and `failEmbedJob` take the claim token as an OPTIONAL argument, because a caller that holds no
 * claim (a delete path, a test) must keep matching by id. So a finish that forgets the token is not an error: it
 * compiles, it passes every test that does not race a rewrite, and it deletes or overwrites a job the record's
 * rewrite has just made pending. Optional is the reason a site gets dropped, so the sites are held here.
 *
 * ## What is derived
 *
 * The claimers: every tracked server source that calls `claimNextEmbedJob(`, with a floor. In each, every call of
 * `completeEmbedJob(` and `failEmbedJob(`, with a floor of one of each across the set. Each must hand over the claimed
 * job's token — `<job>.claimToken`, positionally or as `claimToken: <job>.claimToken` — where `<job>` is the binding
 * the claim was assigned to. Comments are stripped first, so a comment naming the token neither passes nor fails it.
 *
 * Run: node --test testing/standalone/the-embed-worker-finishes-under-its-own-claim.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf } from './_structural-window.mjs';

const CLAIMERS = readTrackedSources('server/src', { ext: ['.ts'], floor: 200 })
  .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), src: stripComments(text) }))
  .filter(({ src }) => /\bclaimNextEmbedJob\(/.test(src) && !/export\s+async\s+function\s+claimNextEmbedJob\b/.test(src));

/** The names a claimed job is bound to in `src`: `const job = await claimNextEmbedJob(…)`. */
const claimBindings = (src) => [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+claimNextEmbedJob\(/g)].map(m => m[1]);

/** Every finish call in `src`: which function, and its argument list. */
function finishCalls(src, file) {
  return [...src.matchAll(/(?<![\w$.])(completeEmbedJob|failEmbedJob)\s*\(/g)]
    .map(m => ({ fn: m[1], args: argumentsOf(src, m.index + m[0].length - 1, `${file} ${m[1]}`) }));
}

describe('every claimer finishes an embed job under the claim it holds', () => {
  it('the derivation found its subjects (floors)', () => {
    assert.ok(CLAIMERS.length >= 1, 'no server source claims an embed job — re-anchor this gate');
    const all = CLAIMERS.flatMap(({ file, src }) => finishCalls(src, file));
    for (const fn of ['completeEmbedJob', 'failEmbedJob']) {
      assert.ok(all.some(c => c.fn === fn), `no claimer calls ${fn} — re-anchor this gate`);
    }
    for (const { file, src } of CLAIMERS) {
      assert.ok(claimBindings(src).length >= 1, `${file} claims an embed job without binding it — re-anchor claimBindings`);
    }
  });

  for (const { file, src } of CLAIMERS) {
    it(`${file}: every complete and fail hands over the claimed job's token`, () => {
      const jobs = claimBindings(src);
      const token = new RegExp(`^(?:claimToken\\s*:\\s*)?(?:${jobs.join('|')})\\.claimToken$`);
      const tokenless = finishCalls(src, file)
        .filter(({ args }) => !args.some(a => token.test(a)
          || (a.startsWith('{') && argumentsOf(a, 0, `${file} options`).some(p => token.test(p.trim())))))
        .map(({ fn, args }) => `${fn}(${args.join(', ')})`);
      assert.deepEqual(tokenless, [],
        `${file} finishes a claimed embed job without naming its claim: once a rewrite has made the job pending again, `
        + 'this finish deletes it (complete) or writes the old attempt\'s backoff over it (fail) — Q-249');
    });
  }
});
