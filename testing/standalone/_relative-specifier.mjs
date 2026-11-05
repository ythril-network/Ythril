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
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { readSchemaPackage } from '../../scripts/_shared/schema-package.mjs';

/** The repo-relative `.ts` path `spec` (as written in `fromFile`) names, or `null` for a non-relative specifier or one that resolves to no tracked file. */
export function resolveRelativeSpecifier(spec, fromFile, has) {
  if (!spec.startsWith('.')) return null;
  const base = posix.join(posix.dirname(fromFile.replace(/\\/g, '/')), spec);
  return [base.replace(/\.js$/, '.ts'), `${base}.ts`, posix.join(base, 'index.ts')].find(has) ?? null;
}

/**
 * The schema package's published name, in ONE place: what the question "what is the workspace package that holds the space-schema vocabulary called"
 * is answered from (Q-683). It is read from schema/package.json, once, when this module loads, so a gate that builds a pattern or an assertion from it
 * follows the manifest through the next rename. It throws at import when the manifest is unreadable or carries no name: a gate built on an empty name
 * would match nothing and pass about nothing, which is the failure a hand-spelled pattern had when the package was renamed.
 */
const SCHEMA_MANIFEST = readSchemaPackage();
if (!SCHEMA_MANIFEST.name.includes('/')) throw new Error('schema/package.json names no scoped package: the schema package has no name to build gates from');

/** The schema package's current name (schema/package.json's `name`). Tests and gates build from this; none spells it. */
export const SCHEMA_PACKAGE_NAME = SCHEMA_MANIFEST.name;

/**
 * The schema package's RETIRED name, under the scope it was first named in. The one sanctioned spelling in the tracked tree outside the released
 * history of CHANGELOG.md: a gate plants it to show that its pattern does not count the retired name, and the named-once gate refuses it anywhere else.
 */
export const RETIRED_SCHEMA_PACKAGE_NAME = '@ythril/schema';

/**
 * A regex SOURCE for the schema package's name followed by exactly one of `subpaths` (`''` is the main entry, `'/internal'` a subpath export). It is a
 * sequence with no top-level alternation, so it embeds in a larger pattern as written. A typo is loud, never an empty match: an empty list, or a
 * subpath that is neither `''` nor a `/segment` path, throws — an empty pattern would let every gate built on it pass about nothing.
 */
export function schemaSpecifierSource(subpaths = ['']) {
  if (!Array.isArray(subpaths) || subpaths.length === 0) throw new Error('schemaSpecifierSource needs at least one subpath (use [\'\'] for the main entry)');
  for (const subpath of subpaths) {
    if (typeof subpath !== 'string' || (subpath !== '' && !/^(?:\/[\w.-]+)+$/.test(subpath))) throw new Error(`a schema package subpath is '' or starts with '/', not ${JSON.stringify(subpath)}`);
  }
  const name = escapeRegExp(SCHEMA_PACKAGE_NAME);
  if (subpaths.length === 1) return `${name}${escapeRegExp(subpaths[0])}`;
  const alternatives = [...subpaths].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return `${name}(?:${alternatives.join('|')})`;
}

/**
 * The repo source file each import specifier of the schema package names — the space-schema package the server imports by name — derived from its name
 * and its manifest's `exports` (`types: ./dist/x.d.ts` is `schema/src/x.ts`), so a new entry or a rename needs no edit here. A gate that follows the
 * server's imports lands on the package's SOURCE, where the code that runs is, never its build.
 */
export const SCHEMA_PACKAGE_ENTRIES = Object.freeze(Object.fromEntries(
  Object.entries(SCHEMA_MANIFEST.exports ?? {}).flatMap(([subpath, target]) => {
    const types = typeof target === 'object' ? target?.types : undefined;
    if (typeof types !== 'string' || !types.startsWith('./dist/') || !types.endsWith('.d.ts')) return [];
    return [[`${SCHEMA_PACKAGE_NAME}${subpath.slice(1)}`, `schema/src/${types.slice('./dist/'.length, -'.d.ts'.length)}.ts`]];
  }),
));

/** {@link resolveRelativeSpecifier}, and a bare specifier of the schema package to the package's source entry when `has` holds it; any other bare specifier is null. */
export function resolveSpecifier(spec, fromFile, has) {
  const entry = SCHEMA_PACKAGE_ENTRIES[spec];
  if (entry) return has(entry) ? entry : null;
  return resolveRelativeSpecifier(spec, fromFile, has);
}
