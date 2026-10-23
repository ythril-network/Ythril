/**
 * Every per-space index is built in ONE place - `spaces/space-indexes.ts`, or a builder that module names - and from the
 * declaration, never from keys written at the call (bundle-101, Q-445 design rev 5.1 items 1 and 6a).
 *
 * ## The rule this holds, and why
 *
 * At df2e7534 a space's indexes are built at fifteen sites in nine files (premise R8), with four failure policies between them (R4):
 * `initSpace`, the background pass, the TTL builder, the edge, keyset, tombstone and job modules each hold a part. A restore that
 * runs "every index" runs whichever of those it remembers, which is how it came back without its TTL indexes. So:
 *
 * - every `createIndex` / `createIndexes` CALL in `server/src` (a call, never a `createIndex:` table key or a comment) is classified
 *   by its target: a collection named through `spaceCollection(...)` or a `` `${…}_…` `` template - directly, or through the
 *   variable or local function the target is read from - is PER-SPACE;
 * - a per-space call sits in `spaces/space-indexes.ts`, or in a function `space-indexes.ts` imports (a builder the declaration
 *   names, such as the guard's thinning build), and its keys are not an object literal written at the call;
 * - every other call is instance-wide or a copy between stores, and its file is a named exemption with its reason; a call that is
 *   neither is a finding, and an exemption that no call needs any more is one too;
 * - floors: per-space calls are found, and so are instance-wide ones, so an empty scan cannot pass.
 *
 * ## Seen red
 *
 * At df2e7534 on the per-space calls: `spaces/space-indexes.ts` does not exist, so every per-space call (lifecycle.ts, the background
 * pass, ttl.ts, keyset-indexes.ts, edge-guard-index.ts, tombstones.ts, job-queue.ts, embed-queue.ts) is outside it. Seen red after
 * the change by putting a hand-written `createIndex({ tags: 1 })` back into `initSpace`, then removing it by hand.
 *
 * Run: node --test testing/standalone/every-per-space-index-build-reads-the-declaration.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression, outermostFunctionOf } from '../_shared/syntax-tree.mjs';

const DECLARATION = 'server/src/spaces/space-indexes.ts';
const BUILD_METHODS = new Set(['createIndex', 'createIndexes']);
/** A collection name that is a space's: the shared builder of one, or a `${space}_<suffix>` template. */
const PER_SPACE_NAME = /\bspaceCollection\s*\(|\$\{[^}]*\}_/;

/** Calls that are not per-space, by file, each with the reason it is not a space's index. */
const NOT_PER_SPACE = [
  { file: 'server/src/audit/audit.ts', why: 'The audit log is one collection for the instance; its indexes serve the audit queries across every space.' },
  { file: 'server/src/brain/read-spill-store.ts', why: 'Read spills are kept outside every space (one headers and one pages collection for the instance).' },
  { file: 'server/src/metrics/space-activity-store.ts', why: 'The activity buckets are one instance-wide collection keyed by space, not a space\'s own collection.' },
  { file: 'server/src/webhooks/dispatcher.ts', why: 'The webhook delivery queue is one collection for the instance.' },
  { file: 'server/src/webhooks/store.ts', why: 'The webhook deliveries log is one collection for the instance.' },
  { file: 'server/src/db/expiry-index.ts', why: 'The TTL (expireAfterSeconds) index of an instance-wide collection named by its caller; no space collection is passed to it.' },
  { file: 'server/src/db/migrate-act.ts', why: 'A store migration copies every collection\'s indexes as the source store holds them, to another store: it builds what is there, not what a space declares.' },
];

const SOURCES = trackedSources('server/src', { untracked: true }).map(file => {
  const text = blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
  return { file, text, sf: parseSource(file, text) };
});

/** The name of a function node: its own, or the variable / property it is assigned to. */
function functionName(fn) {
  if (!fn) return null;
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** Every declaration in `sf` of `name` (a variable's initializer, a function's body, a parameter), as source text. */
function declarationsOf(sf, name) {
  const out = [];
  walkEveryNode(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) out.push(n.initializer.getText(sf));
    else if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) out.push(n.body.getText(sf));
  });
  return out;
}

const BY_FILE = new Map(SOURCES.map(s => [s.file, s]));

/** The source `name` is imported from by `file` through a relative import (its exported name there), or `null`. */
function importedFrom(file, name) {
  const { sf } = BY_FILE.get(file);
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings) || !st.moduleSpecifier.text.startsWith('.')) continue;
    const el = bindings.elements.find(e => e.name.text === name);
    if (!el) continue;
    const target = join(file, '..', st.moduleSpecifier.text).replace(/\\/g, '/').replace(/\.js$/, '.ts');
    return BY_FILE.has(target) ? { file: target, name: el.propertyName?.text ?? name } : null;
  }
  return null;
}

/**
 * The target's text with every identifier in it resolved through its declarations - in the same file, or in the module it is
 * imported from - transitively: `tombstonesOf(spaceId)` reads as what `tombstonesOf` returns.
 */
function resolvedTarget(file, sf, node) {
  const seen = new Set();
  const texts = [node.getText(sf)];
  const queue = [{ file, node }];
  while (queue.length) {
    const { file: at, node: n } = queue.shift();
    walkEveryNode(n, (m) => {
      if (!ts.isIdentifier(m) || seen.has(`${at}#${m.text}`)) return;
      seen.add(`${at}#${m.text}`);
      let home = { file: at, name: m.text };
      let found = declarationsOf(BY_FILE.get(at).sf, m.text);
      if (found.length === 0) {
        const imported = importedFrom(at, m.text);
        if (imported) { home = imported; found = declarationsOf(BY_FILE.get(imported.file).sf, imported.name); }
      }
      for (const text of found) {
        texts.push(text);
        queue.push({ file: home.file, node: parseSource(`${home.file}#${home.name}.ts`, text) });
      }
    });
  }
  return texts.join('\n');
}

/** Every index-build call: `{ file, line, method, perSpace, fn, literalKeys, text }`. */
function buildCalls() {
  const calls = [];
  for (const { file, sf } of SOURCES) {
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrapExpression(n.expression);
      if (!ts.isPropertyAccessExpression(callee) || !BUILD_METHODS.has(callee.name.text)) return;
      const target = unwrapExpression(callee.expression);
      const first = n.arguments[0] && unwrapExpression(n.arguments[0]);
      const literalKeys = !!first && ts.isObjectLiteralExpression(first) && first.properties.some(p => !ts.isSpreadAssignment(p));
      calls.push({
        file, line: lineOf(sf, n), method: callee.name.text, perSpace: PER_SPACE_NAME.test(resolvedTarget(file, sf, target)),
        fn: functionName(outermostFunctionOf(n)), literalKeys, text: n.getText(sf).slice(0, 90).replace(/\s+/g, ' '),
      });
    });
  }
  return calls;
}

/** The names `space-indexes.ts` imports: the builders the declaration names. Empty when the module does not exist. */
function buildersTheDeclarationNames() {
  const home = SOURCES.find(s => s.file === DECLARATION);
  if (!home) return null;
  const names = new Set();
  for (const st of home.sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.add(el.name.text);
  }
  return names;
}

const CALLS = buildCalls();
const at = (c) => `${c.file}:${c.line} ${c.fn ?? '<module>'}: ${c.text}`;

describe('every per-space index build reads the declaration', () => {
  it('the scan finds per-space and instance-wide index builds (floors)', () => {
    assert.ok(CALLS.some(c => c.perSpace), 'no per-space createIndex call was found: the classification is broken');
    assert.ok(CALLS.some(c => !c.perSpace), 'no instance-wide createIndex call was found: the scan read too little');
  });

  it('every per-space call sits in spaces/space-indexes.ts or a builder it names, and builds from the declaration', () => {
    const builders = buildersTheDeclarationNames();
    const findings = [];
    if (!builders) findings.push(`${DECLARATION} does not exist: the per-space indexes have no one declaration`);
    for (const c of CALLS.filter(x => x.perSpace)) {
      const placed = c.file === DECLARATION || (builders?.has(c.fn) ?? false);
      if (!placed) findings.push(`outside the declaration: ${at(c)}`);
      else if (c.literalKeys) findings.push(`keys written at the call, not read from the declaration: ${at(c)}`);
    }
    assert.deepEqual(findings, [], `per-space index builds that do not go through the declaration:\n${findings.join('\n')}`);
  });

  it('every call that is not per-space is in a file named as instance-wide or a copy, and every such row is still needed', () => {
    const unnamed = CALLS.filter(c => !c.perSpace && !NOT_PER_SPACE.some(e => e.file === c.file)).map(at);
    assert.deepEqual(unnamed, [], 'an index build whose target is not read as a space\'s and whose file is not named: classify it, or name it with its reason');
    const stale = NOT_PER_SPACE.filter(e => !CALLS.some(c => !c.perSpace && c.file === e.file)).map(e => e.file);
    assert.deepEqual(stale, [], 'an exemption no instance-wide call needs any more');
    for (const e of NOT_PER_SPACE) assert.ok(e.why.length > 50, `${e.file}: the reason is not an argument`);
  });

  it('no file named as instance-wide builds a per-space index', () => {
    const mixed = CALLS.filter(c => c.perSpace && NOT_PER_SPACE.some(e => e.file === c.file)).map(at);
    assert.deepEqual(mixed, [], 'a file exempt as instance-wide builds a space\'s index');
  });
});
