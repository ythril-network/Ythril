/**
 * `ythril_unknown_write_fields_total` is incremented in ONE module, the judge, with labels from a fixed vocabulary (Q-320,
 * bundle-128, design-v3 section 2b and 8.2 G15).
 *
 * ## The rule
 *
 * Both doors count alike because one function counts, once per judged call that carried an unknown key. A second increment site
 * would count a call twice or on one door only, and a label built from the caller's text would let a caller mint a time series per
 * spelling. So:
 *   1. the metric is registered in `metrics/registry.ts` with exactly the labels `door, operation, mode, outcome`;
 *   2. every reference to its exported counter outside the registry is in `contract/write-accepts.ts`, and there is at least one;
 *   3. in that module, the label object handed to the counter has exactly those four keys and each value is a fixed word or a
 *      named variable of the same name — never a property read of the request body or a key.
 *
 * The VALUE vocabulary (`door` in rest|mcp|tool, `mode` in warn|refuse, `outcome` in stored|refused, `operation` from the derived
 * list) is asserted at runtime by the contract slice's metric test; this gate is the structural half.
 *
 * Seen red on the unchanged base: the metric is not registered and the judge module does not exist.
 *
 * Run: node --test testing/standalone/the-unknown-write-fields-counter-is-incremented-only-by-the-judge.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const METRIC = 'ythril_unknown_write_fields_total';
const JUDGE = 'server/src/contract/write-accepts.ts';
const LABELS = ['door', 'operation', 'mode', 'outcome'];

const registry = stripComments(readFileSync('server/src/metrics/registry.ts', 'utf8'));

/** The exported identifier the counter is declared as, and its declaration, or null when it is not registered. */
function declaration() {
  const at = registry.indexOf(`'${METRIC}'`);
  if (at === -1) return null;
  const head = registry.slice(0, at);
  const m = [...head.matchAll(/export\s+const\s+(\w+)\s*=/g)].pop();
  return m ? { ident: m[1], text: balancedFrom(registry, registry.indexOf('(', m.index)) } : null;
}

describe('the counter is registered with a fixed label set', () => {
  it('it is registered in metrics/registry.ts', () => {
    assert.ok(declaration(), `${METRIC} is not registered`);
  });

  it('with exactly door, operation, mode and outcome as labels', () => {
    const d = declaration();
    assert.ok(d, `${METRIC} is not registered`);
    const m = /labelNames:\s*\[([^\]]*)\]/.exec(d.text);
    assert.ok(m, 'the declaration lists no labelNames');
    assert.deepEqual(m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean).sort(), [...LABELS].sort());
  });
});

describe('only the judge increments it', () => {
  const d = declaration();
  const sources = trackedSources(['server/src'], { floor: 100, untracked: true });

  it('the judge module exists', () => {
    assert.ok(existsSync(JUDGE), `${JUDGE} does not exist`);
  });

  it('no module but the registry and the judge refers to the counter, and the judge does', () => {
    assert.ok(d, `${METRIC} is not registered, so there is no identifier to look for`);
    const users = sources
      .filter(f => f !== 'server/src/metrics/registry.ts')
      .filter(f => new RegExp(`\\b${d.ident}\\b`).test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(users, [JUDGE], 'the counter is incremented outside the judge (or not at all), so the two doors can count differently');
  });

  it('the judge hands it exactly the four labels, never a value read from the body or a key', () => {
    assert.ok(d, `${METRIC} is not registered`);
    assert.ok(existsSync(JUDGE), `${JUDGE} does not exist`);
    const src = stripComments(readFileSync(JUDGE, 'utf8'));
    const calls = [...src.matchAll(new RegExp(`\\b${d.ident}\\s*\\.\\s*(?:inc|labels)\\s*\\(`, 'g'))];
    assert.ok(calls.length >= 1, 'the judge never increments the counter');
    for (const c of calls) {
      const args = balancedFrom(src, c.index + c[0].length - 1);
      const obj = /\{([^{}]*)\}/.exec(args);
      assert.ok(obj, `an increment passes no label object: ${args.slice(0, 80)}`);
      const pairs = obj[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(':').map(x => x.trim()));
      assert.deepEqual(pairs.map(p => p[0]).sort(), [...LABELS].sort(), 'the increment\'s label keys are not the fixed four');
      for (const [k, v] of pairs) {
        const value = v ?? k;
        assert.ok(/^(['"]\w+['"]|\w+)$/.test(value) && !/\b(body|key|keys|req|args)\b/.test(value),
          `label ${k} is built from \`${value}\`, which can carry the caller's text`);
      }
    }
  });
});