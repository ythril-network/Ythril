/**
 * The relative-import graph of a set of tracked TypeScript sources, and what is reachable or cyclic in it.
 *
 * ## What it prevents
 *
 * Two probes (`check-i-architecture-dependency-direction`, `check-i-legal-build-time-only-not-shipped`) each need "which module does this import
 * name". `testing/standalone/_import-closure.mjs` answers it for the server (`.js` specifiers, files read from disk, a broken import throws); the
 * client writes extensionless specifiers and `index.ts` directories, and the probes must also read a planted copy of a source, which a disk reader
 * cannot. The resolution rule is here once: a specifier names the tracked file that is the path, the path with `.js` read as `.ts`, with `.ts`
 * added, or its `index.ts`; a name no tracked source holds is reported as unresolved, never skipped, so a probe can refuse a broken graph.
 *
 * Sources arrive as `{ file, code }` with comments already stripped (the caller strips: a sentence that mentions `import` is not one).
 */
import { posix } from 'node:path';

/** Relative imports (static, dynamic, re-exported) in comment-stripped source: the raw specifiers. */
export function specifiersOf(code) {
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
}

/** The tracked file a specifier names from `file`, or the path it would be (`known` false). */
export function resolveSpecifier(file, spec, known) {
  const base = posix.normalize(posix.join(posix.dirname(file), spec));
  for (const c of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`]) if (known.has(c)) return { target: c, known: true };
  return { target: base, known: false };
}

/** A specifier that names an asset, not a source: left out of `unresolved`. */
const ASSET = /\.(json|scss|css|html|md|svg|png|mjs)$/;

/** `{ edges: Map<file, string[]>, unresolved: { file, spec, target }[] }` over `sources` (`{ file, code }`). */
export function graphOf(sources) {
  const known = new Set(sources.map((s) => s.file));
  const edges = new Map();
  const unresolved = [];
  for (const { file, code } of sources) {
    const out = [];
    for (const spec of specifiersOf(code)) {
      const r = resolveSpecifier(file, spec, known);
      if (r.known) out.push(r.target);
      else if (!ASSET.test(spec)) unresolved.push({ file, spec, target: r.target });
    }
    edges.set(file, out);
  }
  return { edges, unresolved };
}

/** The modules reachable from `entries` along `edges`, entries included. */
export function reachableFrom(edges, entries) {
  const seen = new Set();
  const queue = entries.filter((e) => edges.has(e));
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of edges.get(f) ?? []) if (edges.has(t)) queue.push(t);
  }
  return seen;
}

/** Strongly connected sets of more than one module (Tarjan, iterative so a long chain cannot overflow the stack). */
export function cyclicSets(edges) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sets = [];
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { v } = frame;
      if (frame.i === 0) { index.set(v, counter); low.set(v, counter); counter += 1; stack.push(v); onStack.add(v); }
      const next = edges.get(v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i];
        frame.i += 1;
        if (!edges.has(w)) continue;
        if (!index.has(w)) work.push({ v: w, i: 0 });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p), low.get(v))); }
        if (low.get(v) === index.get(v)) {
          const set = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); set.push(w); } while (w !== v);
          if (set.length > 1) sets.push(set);
        }
      }
    }
  }
  return sets;
}
