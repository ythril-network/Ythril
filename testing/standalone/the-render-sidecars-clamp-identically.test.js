/**
 * The two render sidecars bound a page's pixels the same way, and read their caps the same way (Q-611).
 *
 * ## Why this is a gate and not a test of the sidecar
 *
 * `sidecars/doc-render/app.py` (PDFs) and `sidecars/doc-office/app.py` (office documents, via LibreOffice) are twins:
 * they speak one `/render` contract and the Node caller cannot tell them apart. Each image is built from its own
 * directory only, so the clamp that keeps `width * height * scale^2` under `RENDER_MAX_PIXELS` cannot be a shared
 * module — it is written twice, and a rule written twice is a rule that can be wrong once. A page whose MediaBox says
 * 14400 x 14400 pt allocates ~800 MB in PDFium whatever `dpi` asked for; if only one twin clamps it, the other still
 * takes the container down and the extraction of every document behind it with it. Neither runs here (no
 * pypdfium2, and the integration case needs the stack), so what is checked from this side is the source:
 *
 *  - the clamp functions (every top-level function that reads `MAX_PIXELS`) are the SAME text in both files, comments and
 *    docstrings aside — same names, same bodies;
 *  - both files read `RENDER_MAX_PIXELS` and `RENDER_MAX_RESPONSE_BYTES` from the environment, with the same default,
 *    and refuse a value that is not a positive number at start, naming the variable (a typo that read as 0 would
 *    refuse every page, or one that read as negative would admit all of them);
 *  - the health answer reports both caps, so an operator can read what a running sidecar enforces.
 *
 * The behaviour itself (a tiny PDF with a huge MediaBox answers a page at a lowered dpi, not a dead sidecar) is
 * `testing/integration/render-sidecar.test.js`.
 *
 * Run: node --test testing/standalone/the-render-sidecars-clamp-identically.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

const CAPS = ['RENDER_MAX_PIXELS', 'RENDER_MAX_RESPONSE_BYTES'];

/** Python source without docstrings, comment-only lines, trailing comments and blank lines. */
export function pyCode(src) {
  return src
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+#[^'"]*$/, '').replace(/\s+$/, ''))
    .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    .join('\n');
}

/** Every top-level function of the (already stripped) source: name -> text from its `def` to the next top-level line. */
export function topLevelFunctions(code) {
  const lines = code.split('\n');
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && /^\s/.test(lines[j])) j++;
    out.set(m[1], lines.slice(i, j).join('\n'));
  }
  return out;
}

/** The functions that bound pixels: those whose text reads a `MAX_PIXELS` name. */
export function clampFunctions(code) {
  return new Map([...topLevelFunctions(code)].filter(([, text]) => /MAX_PIXELS/.test(text)));
}

/** The text that reads `name` from the environment: the statement, plus the helper it goes through if it calls one. */
function readingUnit(code, name) {
  const lines = code.split('\n');
  const at = lines.findIndex(l => l.includes(`"${name}"`) || l.includes(`'${name}'`));
  if (at < 0) return null;
  // The statement: its line and the indented lines that continue it, bounded by indentation as `topLevelFunctions` bounds a def.
  let end = at + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end++;
  const unit = [lines.slice(at, end).join('\n')];
  const helper = /(\w+)\s*\(\s*["']RENDER_/.exec(lines[at]);
  if (helper && !/environ/.test(lines[at])) unit.push(topLevelFunctions(code).get(helper[1]) ?? '');
  return unit.join('\n');
}

/** What is wrong with how `code` reads the cap `name`. Empty when nothing is. */
export function capReadViolations(code, name) {
  const unit = readingUnit(code, name);
  if (unit === null) return [`${name} is never read`];
  const v = [];
  if (!/environ|getenv/.test(unit)) v.push(`${name} is not read from the environment`);
  if (!/(<=?\s*0\b|<\s*1\b|>\s*0\b|>=\s*1\b)/.test(unit)) v.push(`${name} has no range check (a value that is not positive must be refused)`);
  if (!/\braise\b|sys\.exit|SystemExit/.test(unit)) v.push(`${name} is range-checked but nothing refuses a bad value at start`);
  return v;
}

/** The default each cap reads when the variable is unset, as written. */
export function capDefault(code, name) {
  const m = new RegExp(`["']${name}["']\\s*,\\s*([^\\n]*?)\\)\\s*\\)?\\s*$`, 'm').exec(code);
  return m ? m[1].replace(/\s+/g, '') : null;
}

/** The body of the health function, or ''. */
function healthBody(code) {
  const fns = [...topLevelFunctions(code)];
  const hit = fns.find(([n]) => n === 'health');
  return hit ? hit[1] : '';
}

/** Everything wrong with a pair of sidecar sources. Empty when nothing is. */
export function twinViolations(renderSrc, officeSrc) {
  const a = pyCode(renderSrc);
  const b = pyCode(officeSrc);
  const v = [];
  const ca = clampFunctions(a);
  const cb = clampFunctions(b);
  if (ca.size === 0) v.push('doc-render has no function that reads MAX_PIXELS: nothing clamps a page');
  if (cb.size === 0) v.push('doc-office has no function that reads MAX_PIXELS: nothing clamps a page');
  for (const name of new Set([...ca.keys(), ...cb.keys()])) {
    if (!ca.has(name)) v.push(`clamp function ${name} is in doc-office only`);
    else if (!cb.has(name)) v.push(`clamp function ${name} is in doc-render only`);
    else if (ca.get(name) !== cb.get(name)) v.push(`clamp function ${name} differs between the twins`);
  }
  for (const [label, code] of [['doc-render', a], ['doc-office', b]]) {
    for (const name of CAPS) {
      for (const why of capReadViolations(code, name)) v.push(`${label}: ${why}`);
      if (!healthBody(code).includes(name) && !new RegExp(`${name.replace('RENDER_', '')}`).test(healthBody(code))) {
        v.push(`${label}: the health answer does not report ${name}`);
      }
    }
  }
  for (const name of CAPS) {
    const da = capDefault(a, name);
    const db = capDefault(b, name);
    if (da !== db) v.push(`${name} defaults differ: doc-render ${da}, doc-office ${db}`);
  }
  return v;
}

// ── the sources ───────────────────────────────────────────────────────────────────────────────────────────────────
const FILES = trackedSources('sidecars', { ext: ['.py'], floor: 2 }).filter(f => /doc-(render|office)\/app\.py$/.test(f));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('the render sidecars clamp a page the same way', () => {
  it('the scan found both twins', () => {
    assert.deepEqual(FILES.map(f => f.split('/')[1]).sort(), ['doc-office', 'doc-render'], `found ${FILES.join(', ')}`);
  });

  it('their clamp functions are identical, both read both caps, and the health answer reports them', () => {
    const render = FILES.find(f => f.includes('doc-render'));
    const office = FILES.find(f => f.includes('doc-office'));
    const found = twinViolations(read(render), read(office));
    assert.deepEqual(found, [], `${found.join('\n')}\n\nThe two sidecars are built from separate directories, so the clamp is written twice: change one and you have changed the other.`);
  });
});

// ── the gate, held to a conforming pair and to each way of losing the rule ────────────────────────────────────────────
const GOOD = `
"""twin"""
import os

def _positive_int_env(name, default):
    raw = os.environ.get(name, default)
    value = int(raw)
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}")
    return value

MAX_PIXELS = _positive_int_env("RENDER_MAX_PIXELS", "40000000")
MAX_RESPONSE_BYTES = _positive_int_env("RENDER_MAX_RESPONSE_BYTES", str(128 * 1024 * 1024))

def clamp_scale(width, height, scale):
    # a comment that differs between the twins is not a difference
    if width * height * scale * scale > MAX_PIXELS:
        return (MAX_PIXELS / (width * height)) ** 0.5
    return scale

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "maxPixels": MAX_PIXELS, "maxResponseBytes": MAX_RESPONSE_BYTES}
`;

describe('the gate itself', () => {
  const noise = GOOD.replace('# a comment that differs between the twins is not a difference', '# another comment');
  const mutate = (from, to) => { assert.ok(GOOD.includes(from), `fixture lost ${from}`); return GOOD.replace(from, to); };

  it('a conforming pair is clean, and a comment difference is not a difference', () => {
    assert.deepEqual(twinViolations(GOOD, GOOD), []);
    assert.deepEqual(twinViolations(GOOD, noise), []);
  });

  const CASES = [
    ['the clamp differs in one twin', GOOD, mutate('> MAX_PIXELS', '>= MAX_PIXELS'), /differs between the twins/],
    ['one twin has no clamp function', GOOD, mutate('def clamp_scale', 'def other_name'), /(only|differs)/],
    ['neither twin clamps', mutate('MAX_PIXELS / (width', '1 / (width').replace(/> MAX_PIXELS/, '> 1'), GOOD, /(only|differs|nothing clamps)/],
    ['a cap is read without a range check', GOOD, mutate('    if value <= 0:\n        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}")\n', ''), /no range check/],
    ['a cap is range-checked and nothing refuses it', GOOD, mutate('        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}")', '        return 1'), /nothing refuses/],
    ['a cap is not read at all', GOOD, mutate('"RENDER_MAX_RESPONSE_BYTES"', '"SOMETHING_ELSE"'), /RENDER_MAX_RESPONSE_BYTES is never read/],
    ['the health answer does not report a cap', GOOD, mutate(', "maxResponseBytes": MAX_RESPONSE_BYTES', ''), /health answer does not report/],
    ['the defaults differ', GOOD, mutate('"40000000"', '"20000000"'), /defaults differ/],
  ];
  for (const [what, a, b, expected] of CASES) {
    it(`flags: ${what}`, () => {
      const found = twinViolations(a, b);
      assert.ok(found.some(m => expected.test(m)), `wanted ${expected}, got ${JSON.stringify(found)}`);
    });
  }
});
