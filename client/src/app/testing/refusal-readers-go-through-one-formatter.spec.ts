/**
 * Every sentence the client shows for a refused request is chosen by ONE module: `core/refusal-text.ts`.
 *
 * bundle-23 (Q-93, F-46) changes what a refusal body IS. The `error` of a schema refusal becomes a CODE
 * (`schema_violation`), the sentence moves to `message`, and the rows (`introduced`, `preExisting`, `declared`,
 * `truncated`, rule outcomes) become structured. A screen that still reads `err.error.error` shows the code to the
 * operator, or an English sentence the server happened to word, in every language. Sixty-odd screens each read the
 * body their own way (`R6-14`: "the 65 `error?.error` readers derived and moved to it in the same change as the body
 * changes"), which is why the change is a sweep and not a one-line edit, and why a sweep needs a gate: the next
 * reader written next year is the same defect arriving as an omission.
 *
 * WHAT COUNTS AS READING THE SENTENCE DIRECTLY, matched in code with comments stripped:
 *  - `.error.error`, `.error?.error`, `?.error?.error` in any spelling or spacing: the body of an HttpErrorResponse is
 *    `err.error`, and its sentence is that body's own `error`;
 *  - the same read through a local: `const body = err?.error; … body?.error`. The first version of a gate like this
 *    would stop at the literal spelling, and `fmtApiError` and the vote-cast mapper both read through `body`.
 *
 * The set is derived from `git ls-files` (`trackedAppSources`), with a floor, and exactly ONE file is exempt: the module
 * every reader is meant to go through. The detector is itself checked against literal spellings (a gate that has never
 * been seen to fail is a claim), and `fmtApiError`'s hard-coded English is held out separately because it is the same
 * defect in the one place the other readers copy from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

const THE_MODULE = 'src/app/core/refusal-text.ts';
const BRAIN_FORMAT = 'src/app/pages/brain/brain-format.ts';

/** Far below the real count (a few hundred); it tells "scanned the app" from "scanned a stub list". */
const SOURCES_FLOOR = 150;

/** Line numbers (1-based) of every direct read of an error body's sentence in `code` (comments already stripped). */
function sentenceReadLines(code: string): number[] {
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  const lines = new Set<number>();

  // `x.error.error`, `x?.error?.error`, `x.error?.error`, any whitespace between the parts.
  for (const m of code.matchAll(/\.error\s*\??\s*\.\s*error\b/g)) lines.add(lineOf(m.index ?? 0));

  // `const body = err?.error;` followed by `body.error` / `body?.error`.
  const aliases = new Set<string>();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?=\s*[^;=\n]*?\.error\s*(?:;|\n|\bas\b|\?\?)/g)) aliases.add(m[1]);
  for (const name of aliases) {
    for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\??\\s*\\.\\s*error\\b`, 'g'))) lines.add(lineOf(m.index ?? 0));
  }
  return [...lines].sort((a, b) => a - b);
}

describe('the detector itself', () => {
  it('sees every spelling of a direct read, and not the lookalikes', () => {
    const bad = [
      'const m = e.error.error;',
      'const m = e?.error?.error;',
      'const m = err.error?.error ?? "x";',
      'const m = (err as { error?: { error?: string } }).error?.error;',
      'const m = e\n  .error\n  ?.error;',
      'const body = err?.error;\nreturn body?.error ?? fallback;',
    ];
    for (const src of bad) expect(sentenceReadLines(src), src).not.toEqual([]);
    const fine = [
      'this.error.set("");',
      'const code = err?.error?.code;',
      'const body = err?.error;\nreturn body?.code;',
      '<app-error-state [reason]="error() ?? \'\'" />',
      'errors.error = true;',
    ];
    for (const src of fine) expect(sentenceReadLines(src), src).toEqual([]);
  });

  it('reports the line a multi-line read is on', () => {
    expect(sentenceReadLines('a\nb\nconst m = e.error?.error;')).toEqual([3]);
  });
});

describe('refusal readers go through one formatter (R6-14)', () => {
  const files = trackedAppSources();

  it('scans the whole app and the one module that is allowed to read the body is among it', () => {
    expect(files.length, 'trackedAppSources returned a short list: a gate over it would report clean about nothing')
      .toBeGreaterThanOrEqual(SOURCES_FLOOR);
    expect(files, `${THE_MODULE} is not tracked: re-point this gate`).toContain(THE_MODULE);
  });

  it('no client source outside core/refusal-text.ts reads an HTTP error body sentence directly', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (file === THE_MODULE) continue;
      const code = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
      scanned++;
      for (const line of sentenceReadLines(code)) offenders.push(`${file}:${line}`);
    }
    expect(scanned, 'the sweep must have read the app').toBeGreaterThanOrEqual(SOURCES_FLOOR - 1);
    // Printed in full on purpose: the list is the work order for the sweep, and a count alone is not actionable.
    expect(
      offenders,
      `${offenders.length} direct reads of an error body's sentence outside ${THE_MODULE}. `
      + 'Route each through describeRefusal / refusalText so a code is translated and a row is rendered, never the raw code:\n  '
      + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('fmtApiError carries no hard-coded English sentence (a refusal is worded by the formatter, in the viewer language)', () => {
    expect(files, `${BRAIN_FORMAT} is not tracked: re-point this gate`).toContain(BRAIN_FORMAT);
    const code = stripComments(readFileSync(resolve(CLIENT_ROOT, BRAIN_FORMAT), 'utf8'));
    const start = code.indexOf('export function fmtApiError');
    // Moved away or deleted is the goal, not a failure: what must not survive is the literal in whatever remains.
    const body = start < 0 ? '' : code.slice(start, ((): number => {
      const next = code.indexOf('\nexport ', start + 1);
      return next < 0 ? code.length : next;
    })());
    expect(body, 'fmtApiError still builds the English sentence "Schema violation" itself').not.toMatch(/Schema violation/);
  });
});
