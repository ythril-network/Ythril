/**
 * Every port a server module is handed its collaborator through is wired at boot, by a module the server's entry loads (bundle-284, slice 6b).
 *
 * ## The rule
 *
 * A module that must not name a collaborator (naming it, statically, dynamically or by a type, would put the collaborator into the server's largest
 * import cycle, whose size `check-i-architecture-dependency-direction` holds to a ceiling that only goes down) is handed it instead: it exports a port,
 * `use<Name>(collaborator)`, keeps a default that THROWS naming the port when nothing was handed in, and one module the server always loads calls the
 * port at its top level. The conversion has three: governance is handed the run (`useSchemaConvertRuns`), and the two MCP tool modules of the
 * conversion are handed their acts (`useSchemaConvertActs`, `useUnconvertedActs`), so neither the run nor an act is a module of that cycle.
 *
 * A port nobody wires passes the type check and every test that wires it by hand, and fails on the first call in production. So, read from the
 * source:
 *
 * - every exported `use<Name>(` function of `server/src` is a port, and at least the conversion's three exist;
 * - each port's module throws, naming the port, when it was never wired (the default fails loudly; it never answers empty);
 * - each port is called at the top level of a module that the server's entry (`server/src/index.ts`) reaches by runtime imports: static `import`
 *   and `export ... from` statements, a type-only import left out (it is erased), a dynamic `import()` left out (it runs only when reached).
 *
 * Seen red on 4c20b928: `useSchemaConvertActs` and `useUnconvertedActs` do not exist (the tools import their acts, and every act joins the cycle).
 *
 * Run: node --test testing/standalone/every-port-a-module-is-handed-is-wired-at-boot.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { resolveSpecifier } from '../../tools/flow-checks/_import-graph.mjs';

/** The server's entry: what `npm start` runs (`node dist/index.js`). */
const ENTRY = 'server/src/index.ts';
/** The ports the conversion is wired through: the floor that proves the scan found its subjects. */
const CONVERSION_PORTS = ['useSchemaConvertRuns', 'useSchemaConvertActs', 'useUnconvertedActs'];

const sources = readTrackedSources('server/src', { specs: false }).map(({ file, text }) => ({ file, code: stripComments(text) }));
const known = new Set(sources.map(s => s.file));
const codeOf = new Map(sources.map(s => [s.file, s.code]));

/** The relative specifiers a module loads when it runs: static imports and re-exports, never a type-only one, never a dynamic `import()`. */
function runtimeSpecifiers(code) {
  const out = [];
  for (const m of code.matchAll(/(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) if (!m[2]) out.push(m[4]);
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** The modules the entry reaches by runtime imports, the entry included. */
function loadedAtBoot() {
  const seen = new Set();
  const queue = [ENTRY];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of runtimeSpecifiers(codeOf.get(f) ?? '')) {
      const r = resolveSpecifier(f, spec, known);
      if (r.known) queue.push(r.target);
    }
  }
  return seen;
}

/** `[{ name, file }]` of every exported `use<Name>(` function. */
const ports = sources.flatMap(({ file, code }) => [...code.matchAll(/\bexport\s+function\s+(use[A-Z]\w*)\s*\(/g)].map(m => ({ name: m[1], file })));

describe('every port a module is handed its collaborator through is wired at boot', () => {
  it('finds the ports, the conversion\'s three among them', () => {
    const names = ports.map(p => p.name);
    const missing = CONVERSION_PORTS.filter(n => !names.includes(n));
    assert.deepEqual(missing, [], `no exported port named ${missing.join(', ')}: the module that must not name its collaborator imports it instead, `
      + 'and the collaborator joins the server\'s largest import cycle');
  });

  it('the entry reaches a meaningful part of the server by runtime imports (the walk works)', () => {
    const boot = loadedAtBoot();
    assert.ok(boot.size > 200, `the entry reaches only ${boot.size} module(s): the import walk broke`);
  });

  it('a port that was never wired throws, naming itself, on its first use', () => {
    const silent = ports.filter(({ name, file }) => !new RegExp(`throw\\s+new\\s+Error\\([^;]*never wired[^;]*\\b${name}\\b|throw\\s+new\\s+Error\\([^;]*\\b${name}\\b[^;]*never wired`).test(codeOf.get(file)))
      .map(p => `${p.name} (${p.file})`);
    assert.deepEqual(silent, [], `a port whose default does not throw "never wired" naming the port: ${silent.join(', ')}`);
  });

  it('each port is called at the top level of a module the server\'s entry loads', () => {
    const boot = loadedAtBoot();
    const unwired = ports.filter(({ name, file }) => ![...boot].some(f => f !== file && new RegExp(`^${name}\\s*\\(`, 'm').test(codeOf.get(f))))
      .map(p => `${p.name} (${p.file})`);
    assert.deepEqual(unwired, [], `a port no module loaded at boot wires at its top level: ${unwired.join(', ')}. Call it beside \`useSchemaConvertRuns\` `
      + '(`api/spaces.ts`) or in the module of the capability the application mounts');
  });
});
