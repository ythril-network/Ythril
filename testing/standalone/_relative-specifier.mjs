/**
 * Which tracked source does a relative import specifier name — the question "where does `'./x.js'` written in `a/b.ts` point", answered once.
 *
 * ## Why a module
 *
 * Two helpers read imports for different questions and each carried the same resolution by hand: `_call-graph.mjs` (which function does this
 * name resolve to: `localName -> { file, exported }`) and `_module-shape.mjs` (which modules does this one import, and does the import survive
 * type erasure), the second in two places. The questions stay apart, and so do their names; the RESOLUTION is the part a copy gets wrong in
 * silence: a specifier is written `./x.js` and the tracked file is `x.ts`, a directory import is `index.ts`, and a specifier that resolves to
 * nothing tracked (a package, a path outside the tree) is not an edge. A copy that dropped the `.js` to `.ts` step made every edge vanish and every
 * gate built on the graph pass about nothing.
 *
 * `has` is a predicate over repo-relative paths, so a caller that holds a Set and one that holds an index both pass what they have.
 */
import { posix } from 'node:path';

/** The repo-relative `.ts` path `spec` (as written in `fromFile`) names, or `null` for a non-relative specifier or one that resolves to no tracked file. */
export function resolveRelativeSpecifier(spec, fromFile, has) {
  if (!spec.startsWith('.')) return null;
  const base = posix.join(posix.dirname(fromFile.replace(/\\/g, '/')), spec);
  return [base.replace(/\.js$/, '.ts'), `${base}.ts`, posix.join(base, 'index.ts')].find(has) ?? null;
}

/**
 * The repo file a bare `@ythril/schema` specifier names — the space-schema package the server imports by name — or null for any other
 * bare specifier. A gate that follows the server's imports lands on the package's SOURCE, where the code that runs is, never its build.
 */
export const SCHEMA_PACKAGE_ENTRIES = Object.freeze({ '@ythril/schema': 'schema/src/index.ts', '@ythril/schema/internal': 'schema/src/internal.ts' });

/** {@link resolveRelativeSpecifier}, and a bare `@ythril/schema` specifier to the package's source entry when `has` holds it. */
export function resolveSpecifier(spec, fromFile, has) {
  const entry = SCHEMA_PACKAGE_ENTRIES[spec];
  if (entry) return has(entry) ? entry : null;
  return resolveRelativeSpecifier(spec, fromFile, has);
}
