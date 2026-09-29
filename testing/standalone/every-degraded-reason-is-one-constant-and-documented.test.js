/**
 * Every reason a recall can be `degraded` for is ONE exported constant, and every place a caller reads the
 * reasons names all of them (Q-102).
 *
 * ## Why
 *
 * The reasons were string literals at each `noteDegraded` call, and the metric's pre-declared series were a
 * third hand-written list in `metrics/registry.ts`. Three copies of one closed vocabulary — and the docs were
 * three more. It had already drifted: `search_timeout` was in the reason table and missing from the metric's
 * documented row. Q-102 adds `filter_window`, the one reason whose absence is the defect it reports, so it is
 * the worst one to lose from a list.
 *
 * ## Derived, never listed
 *
 * The set is read from the module that exports `DEGRADED_REASONS`, found by scanning the source rather than by
 * naming a file. The docs are found by what they contain — the reason table by its header, the metric row by
 * the metric's name, every `maxTimeMS` row that talks about `degraded` — not by filename, because the guide is
 * split across thirty parts and a section moves.
 *
 * Run: node --test testing/standalone/every-degraded-reason-is-one-constant-and-documented.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { blockAfter } from './_structural-window.mjs';

const sources = () => readTrackedSources('server/src', { ext: ['.ts'], floor: 100, specs: false });

/** The module(s) under server/src that export the constant. */
function exporters() {
  return sources().filter(({ text }) => /export\s+const\s+DEGRADED_REASONS\b/.test(stripComments(text))).map(s => s.file);
}

/** Every tracked integration-guide part, read. A listing under two files is a failed listing. */
function guideParts() {
  const files = execFileSync('git', ['ls-files', 'docs/integration-guide/*.md'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(files.length >= 10, `only ${files.length} guide part(s) tracked — the listing is broken, not the docs`);
  return files.map(f => ({ file: f, lines: readFileSync(f, 'utf8').split(/\r?\n/) }));
}

let REASONS = null;

before(async () => {
  const found = exporters();
  if (found.length === 1) {
    const dist = found[0].replace(/^server\/src\//, '../../server/dist/').replace(/\.ts$/, '.js');
    ({ DEGRADED_REASONS: REASONS } = await import(dist));
  }
});

describe('the degraded reasons are one constant', () => {
  it('exactly one module exports DEGRADED_REASONS', () => {
    const found = exporters();
    assert.equal(found.length, 1,
      `DEGRADED_REASONS is exported by [${found.join(', ')}] — the reasons are string literals at each call and a `
      + 'second hand-written list in the metrics registry, so nothing makes the docs, the metric and the code agree');
    assert.ok(Array.isArray(REASONS) && REASONS.length >= 3, `expected a non-trivial list, got ${JSON.stringify(REASONS)}`);
  });

  it('it includes filter_window, the reason Q-102 adds', () => {
    assert.ok(REASONS?.includes('filter_window'),
      'a filtered answer that could not be completed must be able to say so');
  });

  it('every literal reason handed to noteDegraded is in the constant', () => {
    const used = new Set();
    for (const { text } of sources()) {
      for (const m of stripComments(text).matchAll(/noteDegraded\(\s*'([^']+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 3, `found only ${used.size} noteDegraded literal(s) — the sweep is broken`);
    const unknown = [...used].filter(r => !(REASONS ?? []).includes(r));
    assert.deepEqual(unknown, [], 'these reasons reach a caller and are not in DEGRADED_REASONS');
  });

  it('the metric pre-declares its series from the constant, not from a list of its own', () => {
    const registry = stripComments(readFileSync('server/src/metrics/registry.ts', 'utf8'));
    // The definition, then the pre-declare loop after it, bounded by that loop's own statement end.
    const at = registry.indexOf('export const recallDegradedTotal');
    assert.ok(at > -1, 'recallDegradedTotal is not defined in the registry — re-anchor this gate');
    const loopAt = registry.indexOf('for (', at);
    // Up to the loop, the loop's header (what it iterates), then its body, bounded by its own braces.
    const block = registry.slice(at, loopAt) + registry.slice(loopAt, registry.indexOf('{', loopAt))
      + blockAfter(registry, loopAt, 'the pre-declare loop');
    assert.match(block, /DEGRADED_REASONS/, 'the pre-declare loop must iterate DEGRADED_REASONS');
    assert.doesNotMatch(block, /\[\s*'rerank_unavailable'/, 'and must not keep its own copy of the list');
  });
});

describe('every place a caller reads the reasons names all of them', () => {
  const reasons = () => { assert.ok(Array.isArray(REASONS), 'DEGRADED_REASONS is not exported — see the case above'); return REASONS; };

  it('the reason table', () => {
    const owners = guideParts().filter(p => p.lines.some(l => /^\|\s*reason\s*\|\s*meaning\s*\|/i.test(l)));
    assert.equal(owners.length, 1, `expected one reason table, found ${owners.length}`);
    const { file, lines } = owners[0];
    const start = lines.findIndex(l => /^\|\s*reason\s*\|\s*meaning\s*\|/i.test(l));
    const rows = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
    const missing = reasons().filter(r => !rows.some(row => row.startsWith(`| \`${r}\` |`)));
    assert.deepEqual(missing, [], `${file}'s reason table has no row for these`);
    // A closed set grows. A client that treats an unknown reason as an error breaks on the next release.
    const section = [];
    for (let i = start; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) section.push(lines[i]);
    assert.match(section.join('\n'), /unknown/i,
      `${file} must tell a client what to do with a reason it does not know: treat it as "degraded"`);
  });

  it('the metric row', () => {
    const rows = guideParts().flatMap(p => p.lines.filter(l => l.startsWith('| `ythril_recall_degraded_total` |'))
      .map(l => ({ file: p.file, l })));
    assert.equal(rows.length, 1, `expected one metric row, found ${rows.length}`);
    const missing = reasons().filter(r => !rows[0].l.includes(`\`${r}\``));
    assert.deepEqual(missing, [], `${rows[0].file}'s ythril_recall_degraded_total row does not name these`);
  });

  it('every maxTimeMS row that mentions degraded', () => {
    const rows = guideParts().flatMap(p => p.lines.filter(l => l.startsWith('| `maxTimeMS` |') && l.includes('degraded'))
      .map(l => ({ file: p.file, l })));
    assert.ok(rows.length >= 1, 'no maxTimeMS row mentions degraded — the sweep is broken');
    const gaps = rows.flatMap(({ file, l }) => reasons().filter(r => !l.includes(`\`${r}\``)).map(r => `${file}: ${r}`));
    assert.deepEqual(gaps, [], 'a row that explains degraded names only some of the reasons it can carry');
  });
});
