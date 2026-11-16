/**
 * A client page asks again on a delay through `pollUntil`, never through a timer chain of its own.
 *
 * ## Why this gate exists
 *
 * `core/poll-until.ts` carries the guards a hand-written poll forgets: a failed request schedules the next ask
 * (a blip never ends the chain), a hidden tab skips the ask and keeps the schedule, and `stop()` drops an answer
 * still in flight. Q-99 extracted it after the reindex poll was written so that one failed request ended the chain
 * and both Reindex buttons stayed held until a reload. Two hand-written polls were left beside it: the file
 * manager's progress poll (a `setInterval` stopped from a branch) and the shell's conflict badge (a `setInterval`
 * with no hidden-tab skip at all). Q-183 moved the first onto `pollUntil`, gave the second its skip, and bought this.
 *
 * ## The rule
 *
 * In `client/src/app/pages` outside the specs, a timer that asks again is a poll chain and is refused:
 *  - any `setInterval` (it is a repeating ask by definition), and
 *  - a `setTimeout` whose callback re-arms itself: it calls a function that encloses the `setTimeout`.
 *
 * A debounce (`clearTimeout` then one `setTimeout` that acts once), a one-shot delay (a copied-flag reset) and a
 * delay that starts a second one-shot delay (a scroll, then a flash class removed) are none of them a chain, and are
 * not flagged. A chain that is legitimate is named in `client-pages-never-hand-write-a-poll-chain.allow.json`
 * with its reason and a reviewBy date; the count of entries is part of the run.
 *
 * ## What it cannot see
 *
 * A chain that re-arms through a second function (A schedules B, B calls A) has no `setTimeout` calling its own
 * enclosing function and is not flagged; the detector is the direct shapes, which is every shape the client had.
 *
 * ## It cannot pass vacuously
 *
 * The sources come from `git ls-files` through `_sources.mjs` (floor included); the detector is run first on two
 * small texts it must flag and one it must not, and then on the real sites the allow list names (a planted copy of
 * each bad shape taken from the repository, not typed here), each of which it must flag at the line the entry gives.
 *
 * Run: node --test testing/standalone/client-pages-never-hand-write-a-poll-chain.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./client-pages-never-hand-write-a-poll-chain.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries;
const FILE_FLOOR = 150;

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

/** The index of the `)` / `}` that closes the bracket at `open`, or -1 when the text ends first. */
function closeOf(src, open) {
  const up = src[open];
  const down = up === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === up) depth++;
    else if (src[i] === down && --depth === 0) return i;
  }
  return -1;
}

/** Every named function or method in `text` as { name, from, to } — the span of its body. */
function namedFunctions(text) {
  const out = [];
  const method = /^[ \t]*(?:(?:private|public|protected|static|async|override|readonly)\s+)*(\w+)\s*(?:<[^>\n]*>)?\([^)\n]*\)\s*(?::\s*[^{=;\n]+)?\{/gm;
  const arrow = /(?:^|[\s.])(\w+)\s*=\s*(?:async\s*)?\([^)\n]*\)\s*(?::\s*[^={;\n]+)?=>\s*\{/gm;
  const decl = /\bfunction\s+(\w+)\s*(?:<[^>\n]*>)?\([^)\n]*\)\s*(?::\s*[^{=;\n]+)?\{/gm;
  for (const re of [method, arrow, decl]) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (NOT_A_FUNCTION.has(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const to = closeOf(text, open);
      if (to !== -1) out.push({ name: m[1], from: open, to });
    }
  }
  return out;
}

/**
 * The poll chains in one source: [{ line, call, in }] — `call` is setInterval or setTimeout, `in` the innermost
 * function name that holds it (or '' at the top level). Comments are blanked with their newlines kept, so a
 * docblock that names `setInterval` is not a call and every line number is the original's.
 */
export function pollChains(src) {
  const text = blankComments(src.replace(/\r\n/g, '\n'));
  const fns = namedFunctions(text);
  const found = [];
  for (const m of text.matchAll(/\b(setInterval|setTimeout)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(text, open);
    if (end === -1) throw new Error(`a ${m[1]}( call whose parentheses never close: the detector cannot read this file`);
    const call = text.slice(open, end + 1);
    const enclosing = fns.filter(f => f.from < m.index && m.index < f.to).sort((a, b) => a.from - b.from);
    let chain = m[1] === 'setInterval';
    let holder = enclosing.length ? enclosing[enclosing.length - 1].name : '';
    if (!chain) {
      const inner = call.slice(1);
      // The function the callback calls again is the one that holds the chain, innermost first.
      const rearmed = [...enclosing].reverse().find(f => new RegExp(`\\b${f.name}\\s*\\(`).test(inner));
      chain = rearmed !== undefined;
      if (rearmed) holder = rearmed.name;
    }
    if (chain) found.push({ line: text.slice(0, m.index).split('\n').length, call: m[1], in: holder });
  }
  return found;
}

const site = (c) => `${c.call} in ${c.in || '(top level)'}`;
const sources = () => trackedSources('client/src/app/pages', { specs: false, floor: FILE_FLOOR });
const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('the detector', () => {
  it('flags an interval, and a timeout that calls its own function, however deep in the callback', () => {
    assert.deepEqual(pollChains('class A {\n  start(): void {\n    this.t = setInterval(() => this.tick(), 4000);\n  }\n}').map(site), ['setInterval in start']);
    assert.deepEqual(pollChains('class A {\n  private poll(): void {\n    this.t = setTimeout(() => { this.ask(); this.poll(); }, 4000);\n  }\n}').map(site), ['setTimeout in poll']);
    assert.deepEqual(pollChains('class A {\n  connect(): void {\n    es.onerror = () => {\n      this.t = setTimeout(() => this.connect(), 4000);\n    };\n  }\n}').map(site), ['setTimeout in connect']);
  });

  it('does not flag a debounce, a one-shot delay, a delay inside a delay or a mention in a comment', () => {
    assert.deepEqual(pollChains('class A {\n  go(): void {\n    setTimeout(() => { setTimeout(() => this.flash(), 10); }, 10);\n  }\n}'), []);
    assert.deepEqual(pollChains('class A {\n  onEvent(): void {\n    clearTimeout(this.t);\n    this.t = setTimeout(() => this.reload(), 250);\n  }\n}'), []);
    assert.deepEqual(pollChains('class A {\n  copy(): void {\n    setTimeout(() => this.copied.set(false), 2000);\n  }\n}'), []);
    assert.deepEqual(pollChains('// a setInterval( here is prose\n/* setTimeout(() => poll(), 1) */\nconst a = 1;'), []);
  });

  it('reports the line of the original source, comments and all', () => {
    assert.deepEqual(pollChains('// one\n/* two\n three */\nclass A {\n  go(): void {\n    setInterval(() => 1, 5);\n  }\n}').map(c => c.line), [6]);
  });
});

describe('the planted copies: the sites the allow list names are flagged where it says', () => {
  for (const e of ENTRIES) {
    it(`${e.file} is flagged for ${e.site}`, () => {
      const hits = pollChains(read(e.file)).map(site);
      assert.ok(hits.includes(e.site), `${e.file} was read and the detector found ${JSON.stringify(hits)}, not ${e.site}: the detector or the entry is wrong`);
    });
  }
});

describe('the pages', () => {
  const files = sources();

  it(`read at least ${FILE_FLOOR} page sources (read ${files.length}), so an empty listing cannot pass`, () => {
    assert.ok(files.length >= FILE_FLOOR, `only ${files.length} files were read`);
  });

  it('the file manager and the shell are among the files read', () => {
    for (const f of ['client/src/app/pages/files/file-manager.component.ts', 'client/src/app/pages/shell/shell.component.ts']) {
      assert.ok(files.includes(f), `${f} is not among the tracked sources: it moved, and this gate would pass over it`);
    }
  });

  it('no page writes a poll chain of its own, unless the allow list names it', () => {
    const open = [];
    for (const file of files) {
      for (const c of pollChains(read(file))) {
        if (!ENTRIES.some(e => e.file === file && e.site === site(c))) open.push(`${file}:${c.line} ${site(c)}`);
      }
    }
    assert.deepEqual(open, [],
      'a timer that asks again drops a guard pollUntil carries (survive an error, pause in a hidden tab, stop when told). '
      + 'Ask through pollUntil (client/src/app/core/poll-until.ts); a chain that is not an ask goes in '
      + 'client-pages-never-hand-write-a-poll-chain.allow.json with a reason and a reviewBy date.');
  });
});

describe(`the allowlist (${ENTRIES.length} entries)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const label = (e) => `${e.file} ${e.site}`;

  it('every entry has a file, a site, a reason of three words or more and a reviewBy date', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && e.file && typeof e.site === 'string' && e.site
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)
      && !Number.isNaN(Date.parse(e.reviewBy)) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(label), [], 'each entry needs file, site, reason (3+ words) and reviewBy (YYYY-MM-DD)');
  });

  it('no entry is past its reviewBy date', () => {
    const late = ENTRIES.filter(e => typeof e.reviewBy === 'string' && e.reviewBy < today);
    assert.deepEqual(late.map(e => `${label(e)} (reviewBy ${e.reviewBy}, today ${today})`), [], 'review the entry: remove the site, or renew the date with a reason');
  });

  it('every entry is a page source this gate reads', () => {
    const files = sources();
    assert.deepEqual(ENTRIES.filter(e => !files.includes(e.file)).map(label), [], 'the file moved or is not a page source: fix or remove the entry');
  });
});
