/**
 * A test file imports from a local module only names that module exports.
 *
 * ## The failure this prevents (bundle-356, Full run 44893109521)
 *
 * `a-space-act-runner-runs-registers-and-retries-db.test.js` imported `auditRowsOf` from `./_space-act-harness.mjs`, which had renamed it
 * to `auditRowsOfOperation`. Node refused to link the module ("does not provide an export named 'auditRowsOf'"), and the run was red in
 * Standalone (database, shard 2) after 25 minutes. The preflight's `test files parse` stage runs `node --check`, which parses a file and
 * never links it, so the database files (which only CI runs) carried the fault there. The rename's caller search matched single-line
 * imports; this import spans two lines.
 *
 * ## The rule
 *
 * Every named import (`import { a, b as c } from '<relative path>'`) and every `export { x } from '<relative path>'` in a tracked
 * `testing/**` `.js` or `.mjs` file, whose path resolves to another tracked `.js` or `.mjs` file under `testing/`, names something that
 * module exports: `export function/class/const/let/var` (destructuring included), `export { x, y as z }`, `export { x } from`,
 * `export * as ns from`, and what an `export * from '<relative path>'` brings (followed through the chain, a cycle visited once). A
 * default import needs a default export. A namespace import (`import * as`) names nothing and is not judged. An import from a package, a
 * `server/dist` path or any path outside `testing/` is not judged. A module whose exports cannot be listed (`module.exports`, or an
 * `export *` of a file that cannot be followed) is not judged and counted in the output. Files are read as syntax trees, so a mention in
 * a comment or a quoted fixture does not count, and a fault is reported on the line of the name, as the file has it.
 *
 * An exception is listed in `every-local-named-import-is-exported.allow.json` with a reason of three words or more and a `reviewBy` date;
 * an entry past its date, or one for an import that no longer breaks the rule, fails here.
 *
 * Run: node --test testing/standalone/every-local-named-import-is-exported.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { readTrackedSources } from './_sources.mjs';
import { parseSource, lineOf, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./every-local-named-import-is-exported.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries;
const FILE_FLOOR = 1000;
const IMPORT_FLOOR = 500;
const HERE = 'testing/standalone';

const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');
const hasModifier = (node, kind) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === kind);

/** The names a binding pattern (`{ a, b: [c] }`) declares. */
function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/**
 * The exports of every file in `sources` (`{ file, text }`, repo-relative paths), as `Map<file, { names: Set, star: string[], opaque: boolean }>`.
 * `star` holds the resolved paths of the `export *` lines; `opaque` is a module whose exports a tree cannot list.
 */
function declaredExports(sources) {
  const byFile = new Map();
  for (const { file, text } of sources) {
    const sf = parseSource(file, text.replace(/\r\n/g, '\n'));
    const names = new Set();
    const star = [];
    let opaque = false;
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st)) {
        const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        if (!st.exportClause) {
          // `export * from`: followed when the target is a local file, else the module's exports cannot be listed.
          if (from && isRelative(from)) star.push(posix.normalize(posix.join(posix.dirname(file), from)));
          else opaque = true;
        } else if (ts.isNamespaceExport(st.exportClause)) names.add(st.exportClause.name.text);
        else for (const el of st.exportClause.elements) names.add(el.name.text);
      } else if (ts.isExportAssignment(st)) {
        names.add('default');
      } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        const found = [];
        for (const d of st.declarationList.declarations) bindingNames(d.name, found);
        for (const n of found) names.add(n);
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        names.add(hasModifier(st, ts.SyntaxKind.DefaultKeyword) ? 'default' : st.name?.text);
      }
    }
    // A CommonJS module hands node a list its lexer guesses at: not judged.
    walkEveryNode(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'module' && n.name.text === 'exports') opaque = true;
    });
    byFile.set(file, { names, star, opaque });
  }
  return byFile;
}

/**
 * Whether `module` exports `name`, following `export *` (never `default`), a cycle visited once: `true`, `false`, or `null` when the answer
 * cannot be given because a module on the way is opaque or is not in `exports`.
 */
function exportsName(exports, module, name, seen = new Set()) {
  const m = exports.get(module);
  if (!m || m.opaque) return null;
  if (m.names.has(name)) return true;
  if (name === 'default' || seen.has(module)) return false;
  seen.add(module);
  let unknown = false;
  for (const next of m.star) {
    const r = exportsName(exports, next, name, seen);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

/**
 * The faults in `sources` (`{ file, text }`, repo-relative paths with forward slashes): `{ file, line, name, from, module }` for each named
 * or default import, or `export { } from`, of a local module that is among `sources` and does not export the name. `unjudged` counts the
 * names that could not be judged because the module's exports cannot be listed; `imports` counts the names that were judged or not.
 */
export function unexportedLocalImports(sources) {
  const exports = declaredExports(sources);
  const faults = [];
  const opaqueModules = new Set();
  let imports = 0;
  let unjudged = 0;
  for (const { file, text } of sources) {
    const sf = parseSource(file, text.replace(/\r\n/g, '\n'));
    const check = (name, node, spec) => {
      if (!isRelative(spec)) return;
      const module = posix.normalize(posix.join(posix.dirname(file), spec));
      if (!exports.has(module)) return;
      imports += 1;
      const has = exportsName(exports, module, name);
      if (has === null) { unjudged += 1; opaqueModules.add(module); return; }
      if (!has) faults.push({ file, line: lineOf(sf, node), name, from: spec, module });
    };
    for (const st of sf.statements) {
      if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (ts.isImportDeclaration(st) && st.importClause) {
        if (st.importClause.name) check('default', st.importClause.name, spec);
        const nb = st.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) check((el.propertyName ?? el.name).text, el, spec);
      } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) check((el.propertyName ?? el.name).text, el, spec);
      }
    }
  }
  return { faults, imports, unjudged, opaqueModules: [...opaqueModules].sort() };
}

const describeFault = (f) => `${f.file}:${f.line} imports ${f.name} from ${f.from}, which does not export it`;
const planted = (files) => unexportedLocalImports(Object.entries(files).map(([file, text]) => ({ file: `${HERE}/${file}`, text }))).faults.map(describeFault);

describe('the gate recognises an import of a name the local module does not export', () => {
  it('flags a name the module lacks, naming the importer, the line and the name', () => {
    assert.deepEqual(planted({
      'a.test.js': `import { one } from './h.mjs';\n`,
      'h.mjs': `export const two = 2;\n`,
    }), [`${HERE}/a.test.js:1 imports one from ./h.mjs, which does not export it`]);
  });

  it('flags a multi-line import on the line of the missing name, not the line of the import', () => {
    assert.deepEqual(planted({
      'a.test.js': `import {\n  two,\n  one,\n  three,\n} from './h.mjs';\n`,
      'h.mjs': `export const two = 2;\nexport const three = 3;\n`,
    }), [`${HERE}/a.test.js:3 imports one from ./h.mjs, which does not export it`]);
  });

  it('flags the old name of a renamed export, the failure this gate exists for', () => {
    const faults = planted({
      'a.test.js': `import {\n  netFixture, auditRowsOf,\n} from './_harness.mjs';\n`,
      '_harness.mjs': `export function netFixture() {}\nexport async function auditRowsOfOperation() {}\n`,
    });
    assert.deepEqual(faults, [`${HERE}/a.test.js:2 imports auditRowsOf from ./_harness.mjs, which does not export it`]);
  });

  it('judges the name before an alias, and a re-export list, and a default import', () => {
    assert.equal(planted({ 'a.test.js': `import { one as uno } from './h.mjs';\n`, 'h.mjs': `export const two = 2;\n` }).length, 1);
    assert.equal(planted({ 'a.test.js': `export { one } from './h.mjs';\n`, 'h.mjs': `export const two = 2;\n` }).length, 1);
    assert.equal(planted({ 'a.test.js': `import h from './h.mjs';\n`, 'h.mjs': `export const two = 2;\n` }).length, 1);
  });

  it('passes a name exported by `export { }`, `export const`, `export function`, a destructuring export and an `as` rename', () => {
    const h = `const one = 1;\nexport { one, one as uno };\nexport const two = 2;\nexport async function three() {}\nexport class Four {}\nexport const { five, six: [seven] } = {};\n`;
    assert.deepEqual(planted({
      'a.test.js': `import { one, uno, two, three, Four, five, seven } from './h.mjs';\n`, 'h.mjs': h,
    }), []);
  });

  it('passes a name exported through `export * from`, along a chain and around a cycle, and a default one', () => {
    assert.deepEqual(planted({
      'a.test.js': `import { deep } from './h.mjs';\n`,
      'h.mjs': `export * from './mid.mjs';\n`,
      'mid.mjs': `export * from './leaf.mjs';\nexport * from './h.mjs';\n`,
      'leaf.mjs': `export const deep = 1;\n`,
    }), []);
    assert.deepEqual(planted({
      'a.test.js': `import fallback from './h.mjs';\nimport { named } from './h.mjs';\n`,
      'h.mjs': `export default function () {}\nexport { x as named };\nconst x = 1;\n`,
    }), []);
  });

  it('flags a name that only the star-exported module\'s default has, and a name absent along the whole chain', () => {
    assert.equal(planted({
      'a.test.js': `import d from './h.mjs';\n`, 'h.mjs': `export * from './leaf.mjs';\n`, 'leaf.mjs': `export default 1;\n`,
    }).length, 1);
    assert.equal(planted({
      'a.test.js': `import { nope } from './h.mjs';\n`, 'h.mjs': `export * from './h2.mjs';\n`, 'h2.mjs': `export * from './h.mjs';\nexport const x = 1;\n`,
    }).length, 1);
  });

  it('ignores a package import, a path outside the files given, a namespace import, a comment and a quoted fixture', () => {
    assert.deepEqual(planted({
      'a.test.js': `import { describe } from 'node:test';\nimport { x } from '../../server/dist/x.js';\nimport * as ns from './h.mjs';\n`
        + `// import { one } from './h.mjs';\nconst src = "import { one } from './h.mjs'";\n`,
      'h.mjs': `export const two = 2;\n`,
    }), []);
  });

  it('does not judge a module whose exports it cannot list, and counts it', () => {
    const sources = [
      { file: `${HERE}/a.test.js`, text: `import { x } from './cjs.js';\nimport { y } from './star.mjs';\n` },
      { file: `${HERE}/cjs.js`, text: `module.exports = { z: 1 };\n` },
      { file: `${HERE}/star.mjs`, text: `export * from 'some-package';\n` },
    ];
    const r = unexportedLocalImports(sources);
    assert.deepEqual(r.faults, []);
    assert.equal(r.unjudged, 2);
    assert.deepEqual(r.opaqueModules, [`${HERE}/cjs.js`, `${HERE}/star.mjs`]);
  });
});

describe('the repository', () => {
  const files = readTrackedSources('testing', { ext: ['.js', '.mjs'], floor: FILE_FLOOR });
  const result = unexportedLocalImports(files);
  const allowed = (f) => ENTRIES.some(e => e.file === f.file && e.name === f.name);

  it(`read at least ${FILE_FLOOR} files (read ${files.length}) and judged at least ${IMPORT_FLOOR} local names (saw ${result.imports}), so a broken scan cannot pass`, () => {
    assert.ok(files.length >= FILE_FLOOR, `only ${files.length} files were read`);
    assert.ok(result.imports >= IMPORT_FLOOR, `only ${result.imports} local imports were seen: the detector is blind`);
    console.log(`every-local-named-import-is-exported: ${result.imports} local names seen, ${result.unjudged} not judged `
      + `(${result.opaqueModules.length} modules whose exports cannot be listed${result.opaqueModules.length ? `: ${result.opaqueModules.join(', ')}` : ''}), `
      + `${ENTRIES.length} exception(s)`);
  });

  it('no test file imports a name its local module does not export, unless the allowlist names it', () => {
    const bad = result.faults.filter(f => !allowed(f));
    assert.deepEqual(bad.map(describeFault), [],
      `${bad.length} import(s) name something the module does not export: node refuses to link such a file, and \`node --check\` does not. `
      + 'Import the name the module exports now (the module may have renamed it); an exception goes in '
      + 'every-local-named-import-is-exported.allow.json with a reason and a reviewBy date.');
  });
});

describe(`the allowlist (${ENTRIES.length} exceptions)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const files = readTrackedSources('testing', { ext: ['.js', '.mjs'], floor: FILE_FLOOR });
  const still = unexportedLocalImports(files).faults;

  it('every entry has a file, a name, a reason of three words or more and a reviewBy date', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && e.file && typeof e.name === 'string' && e.name
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)
      && !Number.isNaN(Date.parse(e.reviewBy)) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(e => `${e.file ?? ''} ${e.name ?? ''}`.trim() || JSON.stringify(e)), [], 'each entry needs file, name, reason (3+ words) and reviewBy (YYYY-MM-DD)');
  });

  it('no entry is past its reviewBy date', () => {
    const late = ENTRIES.filter(e => typeof e.reviewBy === 'string' && e.reviewBy < today);
    assert.deepEqual(late.map(e => `${e.file} ${e.name} (reviewBy ${e.reviewBy}, today ${today})`), [], 'review the entry: fix the import, or renew the date with a reason');
  });

  it('every entry still names an import the module does not export', () => {
    const gone = ENTRIES.filter(e => !still.some(f => f.file === e.file && f.name === e.name));
    assert.deepEqual(gone.map(e => `${e.file} ${e.name}`), [], 'the import is fixed, or the file is gone: delete the entry');
  });
});
