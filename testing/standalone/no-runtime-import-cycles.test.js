/**
 * The server has no import cycle that survives to runtime.
 *
 * ## What this angle found, and what it did not
 *
 * Lens 2's import-direction question, quantified over `server/src` (232 modules):
 *
 *   - **2 cycles in the TypeScript source**, both a pair in the same directory:
 *     `audit-changes` ↔ `audit-schema-summary`, and `recall` ↔ `lexical-search`.
 *   - **0 cycles in the emitted JavaScript.** Each pair is one value import and one `import type` back, and
 *     the type import is erased — `dist/audit/audit-schema-summary.js` contains zero references to
 *     `audit-changes`, and `dist/brain/lexical-search.js` zero to `recall`. Checked in `dist`, not inferred
 *     from the compiler flags.
 *   - **14 "upward" imports** (core reaching toward the edge) by a naive directory ranking, of which ten were
 *     the ranking being wrong (`util` and `metrics` legitimately use `config` and `db`). The remaining four
 *     survive reading: `auth → mcp/oauth` builds the `WWW-Authenticate` resource-metadata URL the OAuth spec
 *     requires; `brain/tombstone-prune → sync/*` reads the peer watermark so a prune cannot delete a
 *     tombstone that would then resurrect from a peer; `config/model-egress-exposure → files/…/vlm-endpoint`
 *     reuses the real endpoint resolver rather than growing a second copy of it.
 *
 * So the angle produced no defect — which is a result, and the reason this file exists is to keep it one.
 *
 * ## Why the check is "survives erasure" and not "no cycles"
 *
 * A source-level cycle broken by `import type` is not a hazard: nothing is evaluated, nothing can be
 * `undefined` at module-init time. Forbidding those would mean rewriting two honest type imports to satisfy a
 * rule about a problem that does not exist — and the first person to hit it would work around the gate rather
 * than the code. What matters is a cycle among the imports that actually run.
 *
 * Run: node --test testing/standalone/no-runtime-import-cycles.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const files = trackedSources(SERVER_CODE_ROOTS);

const norm = (p) => relative(ROOT, p).replaceAll('\\', '/');

/** Resolve a relative specifier to a repo-relative `.ts` path, or null when it leaves the tree. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(ROOT, fromFile)), spec);
  for (const cand of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    const rel = norm(cand);
    if (files.includes(rel)) return rel;
  }
  return null;
}

/**
 * Module graph of imports that SURVIVE type erasure.
 *
 * `import type ...` / `export type ...` are dropped: they emit nothing, so they cannot form a runtime cycle.
 * An inline `import { type Foo, bar }` is kept — it still imports `bar`.
 */
function runtimeGraph() {
  const graph = new Map();
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const deps = new Set();
    const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[2]) continue;                       // `import type` — erased
      const target = resolveImport(f, m[3]);
      if (target && target !== f) deps.add(target);
    }
    graph.set(f, deps);
  }
  return graph;
}

/** Tarjan strongly-connected components of size > 1 — i.e. the cycles. */
function cycles(graph) {
  let idx = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return out;
}

describe('server modules form no runtime import cycle', () => {
  const graph = runtimeGraph();

  it('walked the whole server tree', () => {
    // Floors the enumeration: a changed pathspec would otherwise make an empty graph look acyclic.
    assert.ok(files.length >= 150, `only found ${files.length} server source files`);
    const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
    assert.ok(edges >= 300, `only resolved ${edges} internal imports — the resolver is probably broken`);
  });

  it('has no cycle among imports that survive type erasure', () => {
    const found = cycles(graph).map(c => c.map(f => f.replace('server/src/', '')).join(' <-> '));
    assert.deepEqual(found, [],
      'these modules import each other at RUNTIME. In ESM that is legal until one of them reads a binding '
      + 'during module evaluation, at which point it is `undefined` and the failure is a TypeError far from '
      + 'the cause. Break the cycle, or make one direction `import type` if it is only a type.');
  });

  it('the erasure rule is what makes that pass — it is not vacuous', () => {
    // Both known source-level pairs are one value import and one `import type` back. If `import type` were
    // treated as a runtime edge, this suite would report two cycles — so this asserts the distinction is
    // load-bearing rather than a claim in a comment.
    const withTypes = new Map();
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const deps = new Set();
      const re = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const t = resolveImport(f, m[1]);
        if (t && t !== f) deps.add(t);
      }
      withTypes.set(f, deps);
    }
    assert.ok(cycles(withTypes).length > 0,
      'no source-level cycle exists any more, so this test proves nothing — delete it and keep the one above');
  });
});
