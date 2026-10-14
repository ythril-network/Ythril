/**
 * What a TypeScript module declares, exports and imports — read from its syntax tree, for the gates that hold a MODULE SPLIT.
 *
 * ## Why a module
 *
 * The two gates over the split of `files/tombstones.ts` (`the-move-marker-block-is-its-own-module`,
 * `move-marker-queries-are-read-through-the-pager`) each ask the same three questions of a source: which top-level names does it
 * define, which does it export (a re-export counts: it is a second door to a name), and which relative modules does it import,
 * and did the import survive type erasure. A regular expression over the text answers the first two wrongly for an overload,
 * a destructured export or a comment that spells `export function x`, and the third differently from `no-runtime-import-cycles`
 * when a specifier is split over lines. Read from the tree, a mention in a comment or a string is not a declaration.
 *
 * ## What it does NOT do
 *
 * No type checker and no resolution beyond a relative specifier: an import of a package, or of a path that leaves the tracked
 * tree, is not an edge. Dynamic `import()` is not an edge either (it is not evaluated at load, so it cannot make a cycle).
 */
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { resolveRelativeSpecifier } from './_relative-specifier.mjs';

const isExported = (node) => !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * Every top-level declaration of a source: `{ name, kind, exported, node }`. `kind` is `function`, `const` (any variable
 * statement), `class`, `interface` or `type`. A name that is only re-exported (`export { x } from`) is not a declaration here —
 * see {@link exportedNames}.
 */
export function topLevelDeclarations(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.push({ name: st.name.text, kind: 'function', exported: isExported(st), node: st });
    else if (ts.isClassDeclaration(st) && st.name) out.push({ name: st.name.text, kind: 'class', exported: isExported(st), node: st });
    else if (ts.isInterfaceDeclaration(st)) out.push({ name: st.name.text, kind: 'interface', exported: isExported(st), node: st });
    else if (ts.isTypeAliasDeclaration(st)) out.push({ name: st.name.text, kind: 'type', exported: isExported(st), node: st });
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, kind: 'const', exported: isExported(st), node: d });
      }
    }
  }
  return out;
}

/**
 * Every name the source makes available to an importer: its exported declarations, and what `export { a, b as c }` (with or
 * without `from`) names. A re-export is counted because it is a second door to the name — the one a split leaves behind so that
 * no caller has to move, and the one that keeps the old module the place everybody still reads the name from.
 */
export function exportedNames(file, text) {
  const sf = parseSource(file, text);
  const names = new Set(topLevelDeclarations(file, text).filter(d => d.exported).map(d => d.name));
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * The relative modules a source imports (or re-exports from), as repo-relative `.ts` paths, with whether the import survives type
 * erasure. `import type` and `export type` are erased; `import { type A }` alone is erased only when EVERY specifier is a type
 * (TypeScript elides it then), and `import { type A, b }` is kept for `b`. A specifier that resolves to nothing in `known` is
 * not an edge.
 *
 * @param {string} file repo-relative path of the importing source
 * @param {string} text its source
 * @param {ReadonlySet<string>|string[]} known the repo-relative paths a specifier may resolve to
 * @returns {Array<{ to: string, runtime: boolean }>}
 */
export function relativeImports(file, text, known) {
  const sf = parseSource(file, text);
  const set = known instanceof Set ? known : new Set(known);
  const out = [];
  const add = (spec, runtime) => {
    const to = resolveRelativeSpecifier(spec, file, c => set.has(c));
    if (to && to !== file) out.push({ to, runtime });
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      let runtime = true;
      if (c?.isTypeOnly) runtime = false;
      else if (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings)
        && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every(e => e.isTypeOnly)) runtime = false;
      add(st.moduleSpecifier.text, runtime);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      add(st.moduleSpecifier.text, !st.isTypeOnly);
    }
  }
  return out;
}

/** The names a source imports from the module `target` (repo-relative), by the specifier's own spelling: `{ a, b as c }` gives `a`, `b`. */
export function namesImportedFrom(file, text, target, known) {
  const sf = parseSource(file, text);
  const set = known instanceof Set ? known : new Set(known);
  const names = new Set();
  for (const st of sf.statements) {
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
      ? st.moduleSpecifier.text : null;
    if (!spec || resolveRelativeSpecifier(spec, file, c => set.has(c)) !== target) continue;
    if (ts.isImportDeclaration(st)) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add((el.propertyName ?? el.name).text);
    } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add((el.propertyName ?? el.name).text);
    }
  }
  return names;
}
