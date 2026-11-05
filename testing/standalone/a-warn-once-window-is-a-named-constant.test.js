/**
 * The window of a `warnOnce` is a named constant, never a number typed at the call (b235).
 *
 * ## The defect it prevents
 *
 * "Say a repeated line once per ten minutes" was typed as `every: 10 * 60_000` at fifteen call sites, each the same answer to the same question and each free
 * to drift: a site that typed `5 * 60_000` or `600_000` would say its line at another rate and nothing would show it. `SAY_ONCE_WINDOW_MS`
 * (`util/warn-once.ts`) is the one number for the question; a window that answers ANOTHER question (an hour for a file system's refusal, a minute for a
 * fault, a hold's twenty hours) is its own NAMED constant with the reason beside it. Either way the call reads `every: NAME`, so the window can be searched,
 * changed once and told apart by what it is called. This holds that no call in `server/src` passes a number.
 *
 * ## What it reads
 *
 * Every `warnOnce(…)` / `warnOnce<K>(…)` call in a tracked source of `server/src`, comments blanked with the line numbers kept (`blankComments`), so a finding is
 * reported as `path:line` of the `every:` it names. The value of `every:` is a LITERAL when it is made only of digits, `_`, `.`, `e`, `+`, `-`, `*`, `/`,
 * parentheses and spaces: `600_000`, `10 * 60_000`, `(10 * 60_000)`. A name, a member path, a parameter or a call (`every: window`, `every: SAY_ONCE_WINDOW_MS`)
 * is not. A call with no `every:` (a latch that never comes back) is not a window and is not read.
 *
 * What it does not read: an options object built elsewhere and passed by name (`warnOnce(FAULT_REPORT_WINDOW)`) — its `every:` is not in the call.
 *
 * ## It cannot pass by reading nothing
 *
 * Floors on the files read, the `warnOnce` calls found and the calls that carry a window, so a pattern that stopped matching shows up at once; and every
 * spelling below is a fixture that must be found, on its own and planted in a real source of the tree.
 *
 * Run: node --test testing/standalone/a-warn-once-window-is-a-named-constant.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const CALL = /\bwarnOnce\s*(?:<[^>()]*>)?\s*\(/g;
const EVERY = /\bevery\s*:\s*([^,}\n]+)/;
const LITERAL = /^(?=.*\d)[\d_.e+\-*/()\s]+$/i;

/**
 * Every `warnOnce` call of one source (comments already blanked, line numbers kept) as `{ line, windows, literal }`, `windows` being the `every:` values the call
 * carries and `literal` the ones that are a number, each with the line it stands on.
 *
 * @returns {{ line: number, windows: string[], literal: { value: string, line: number }[] }[]}
 */
export function warnOnceCallsIn(src) {
  const out = [];
  for (const m of src.matchAll(CALL)) {
    const open = m.index + m[0].length - 1;
    const call = balancedFrom(src, open, 'a warnOnce call');
    const windows = [];
    const literal = [];
    // Each `every:` of the call, with the line it stands on (a call may span lines).
    for (const each of call.matchAll(new RegExp(EVERY.source, 'g'))) {
      const value = each[1].trim();
      windows.push(value);
      if (LITERAL.test(value)) literal.push({ value, line: src.slice(0, open + each.index).split('\n').length });
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, windows, literal });
  }
  return out;
}

/** The `path:line: every: <literal>` finding of every literal window in one source. */
export function literalWindowsIn(file, src) {
  return warnOnceCallsIn(blankComments(src)).flatMap(c => c.literal.map(l => `${file}:${l.line}: \`every: ${l.value}\``));
}

describe('the reader finds a literal window in each spelling, and passes a named one', () => {
  const planted = [
    ['a product of minutes', 'const a = warnOnce<string>({ every: 10 * 60_000 });'],
    ['one number', 'const a = warnOnce<string>({ every: 600_000 });'],
    ['an hour', 'const a = warnOnce<string>({ max: 16, every: 60 * 60_000 });'],
    ['a parenthesised product', 'const a = warnOnce<string>({ every: (10 * 60_000) });'],
    ['a window after other options', 'const a = warnOnce<string>({ every: 60_000, max: 5 });'],
    ['no type argument', 'const a = warnOnce({ every: 10 * 60_000 });'],
    ['a type argument that is a union', "const a = warnOnce<'a' | 'b'>({ every: 10 * 60_000 });"],
    ['a call over several lines', 'const a = warnOnce<string>({\n  max: 3,\n  every: 5 * 60_000,\n});'],
    ['an exponent', 'const a = warnOnce<string>({ every: 6e5 });'],
  ];
  for (const [what, code] of planted) {
    it(`finds: ${what}`, () => {
      assert.equal(literalWindowsIn('planted.ts', code).length, 1, `a literal window written as ${what} was not found in: ${code}`);
    });
  }

  it('reports the line of the `every:` of a call over several lines', () => {
    assert.deepEqual(literalWindowsIn('planted.ts', 'x;\nconst a = warnOnce<string>({\n  max: 3,\n  every: 5 * 60_000,\n});'),
      ['planted.ts:4: `every: 5 * 60_000`']);
  });

  const passing = [
    ['the shared constant', 'const a = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });'],
    ['a constant of its own', 'const a = warnOnce<string>({ max: 16, every: LINK_FALLBACK_WINDOW_MS });'],
    ['a parameter', 'const once = warnOnce<string>({ max, every: window, now });'],
    ['a member path', 'const a = warnOnce<string>({ every: WINDOWS.say });'],
    ['no window at all', 'const a = warnOnce<string>({ max: 1 });'],
    ['no options at all', 'const a = warnOnce<string>();'],
    ['an options object built elsewhere', 'const a = warnOnce<string>(FAULT_REPORT_WINDOW);'],
    ['a literal in a comment', 'const a = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS }); // not every: 10 * 60_000'],
    ['a literal in a block comment', '/* warnOnce({ every: 600_000 }) */\nconst a = 1;'],
    ['a literal that is not a warnOnce window', 'const b = { every: 60_000 };'],
    ['a literal in another call', 'const a = setTimer({ every: 10 * 60_000 });'],
  ];
  for (const [what, code] of passing) {
    it(`does not report: ${what}`, () => {
      assert.deepEqual(literalWindowsIn('fine.ts', code), []);
    });
  }
});

describe('no warnOnce in server/src is given a literal window', () => {
  const files = trackedSources('server/src', { untracked: true });
  const sources = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), 'utf8')]));
  const calls = [...sources].flatMap(([file, src]) => warnOnceCallsIn(blankComments(src)).map(c => ({ file, ...c })));

  it('reads a tree worth reading (the floors)', () => {
    assert.ok(sources.size >= 300, `only ${sources.size} source files were read`);
    assert.ok(calls.length >= 30, `only ${calls.length} warnOnce call(s) were found in server/src — the tree has dozens, so the reader has stopped matching`);
    const windowed = calls.filter(c => c.windows.length > 0).length;
    assert.ok(windowed >= 20, `only ${windowed} warnOnce call(s) carry an \`every:\` — the tree has dozens, so the reader has stopped matching, and an empty set passes every assertion below`);
  });

  it('every window is a name', () => {
    const findings = [...sources].flatMap(([file, src]) => literalWindowsIn(file, src));
    assert.deepEqual(findings, [],
      `a window typed at the call can drift from the others and cannot be searched:\n  ${findings.join('\n  ')}\n`
      + 'Use `SAY_ONCE_WINDOW_MS` (util/warn-once.ts) when the line means "a repeat is the same news for ten minutes"; otherwise name the window in a constant '
      + 'beside the call, with the reason it is not that.');
  });

  it('a literal planted in a real source of the tree is found (the gate is seen red on the repository, not only on a fixture)', () => {
    const [file, src] = [...sources].find(([, s]) => /every: SAY_ONCE_WINDOW_MS/.test(s));
    const plant = src.replace('every: SAY_ONCE_WINDOW_MS', 'every: 10 * 60_000');
    const found = literalWindowsIn(file, plant);
    assert.equal(found.length, 1, `planting \`every: 10 * 60_000\` in ${file} was not found`);
    assert.match(found[0], new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+: `));
  });
});
