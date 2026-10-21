/**
 * A `computed()` never reads the active language through `getActiveLang()` (bundle-162's pre-ship sweep).
 *
 * `getActiveLang()` is a plain read, not a signal, so a `computed()` that calls it does not re-run when the viewer switches
 * language: its sentence stays in the old language until some other signal it reads changes. The stored-data check's "Checked N
 * of M records" did, found by review, and this gate found the same in three more components; each rendered correctly in every
 * spec, because a spec sets the language once. Read the language as a signal (`toSignal(transloco.langChanges$, ...)`) inside a `computed()`, or render the
 * sentence from a method, which change detection re-runs.
 *
 * The files are every tracked client source (`git ls-files`), so a component written next year is inside the net.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';
import { callArguments } from './call-arguments';

describe('a computed() text follows the language', () => {
  const computedBodies: { where: string; body: string }[] = [];
  for (const file of trackedAppSources()) {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    for (const m of src.matchAll(/\bcomputed(?:<[^>()]*>)?\(/g)) {
      const open = m.index! + m[0].length - 1;
      computedBodies.push({ where: `${file}:${src.slice(0, m.index!).split('\n').length}`, body: callArguments(src, open)[0] ?? '' });
    }
  }

  it('finds the computed() calls (a floor, so a changed call shape cannot pass by finding none)', () => {
    expect(computedBodies.length).toBeGreaterThanOrEqual(100);
  });

  it('no computed() calls getActiveLang(), which is not a signal and so never re-runs it on a language switch', () => {
    const stale = computedBodies.filter(c => /\bgetActiveLang\s*\(/.test(c.body)).map(c => c.where);
    expect(stale, `computed() texts that keep the old language after a switch:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
