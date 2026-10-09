/**
 * The edge guard index is declared ONCE, keys AND options, and every build of it reads that declaration (`Q-439`).
 *
 * ## The rule
 *
 * `EDGE_GUARD_INDEXES` declares the index the functional guard collides on: `{ _functionalGuard: 1 }`, UNIQUE, with a
 * partial filter `{ _functionalGuard: { $type: 'string' } }`. `initSpace` (a new collection), the `ensureQueryIndexes` unit
 * (an existing one) and the online restore all build it through ONE function, `ensureEdgeGuardIndex`, which reads the keys
 * and the options from the declaration.
 *
 * The options are the half a copy drops. `LINK_INDEXES` is declared once and still built as
 * `createIndex(ix.keys, ix.unique ? { unique: true } : {})` at both sites: the KEYS are shared and the OPTIONS are spelled
 * by hand twice. For this index the options ARE the guard: without `unique` nothing collides, and without the partial filter
 * every unmarked edge is `null` and the second one collides. Worse, `$exists: true` would index a `null` and collide
 * the same way, which is why the filter is `$type: 'string'` and is asserted here.
 *
 * ## What is derived
 *
 * The declaration and `ensureEdgeGuardIndex` are FOUND by scanning `server/src` for their declarations, never named by path,
 * so a move does not blind this gate (and it fails loudly when either is found nowhere, or twice). The "no hand-built
 * index" half scans every source file for a `createIndex` naming the marker.
 *
 * ## Seen red
 *
 * Red on 9a4b41c6: the declaration and the function exist nowhere. Mutations, each put back by hand: write
 * `{ unique: true }` literally in `ensureEdgeGuardIndex` (red: options not read from the declaration); build the index with
 * a `createIndex({ _functionalGuard: 1 }, ...)` in `initSpace` (red: a hand-built site); change the filter to
 * `{ $exists: true }` (red: the options case).
 *
 * Run: node --test testing/standalone/the-edge-guard-index-is-declared-once-with-its-options.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const MARKER = '_functionalGuard';

/** Untracked too: the file a change adds is the one this most needs to see. */
const FILES = trackedSources('server/src', { untracked: true }).map(file => ({
  file, src: stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')),
}));

/** The one file whose source matches `declared`; throws (as a failed assertion) when there is none or several. */
function homeOf(name, declared) {
  const homes = FILES.filter(f => declared.test(f.src));
  assert.ok(homes.length > 0, `\`${name}\` is declared in no file under server/src: the guard index has no single definition`);
  assert.equal(homes.length, 1, `\`${name}\` is declared in ${homes.length} files (${homes.map(h => h.file).join(', ')}): one definition, two homes`);
  return homes[0];
}

const declarationHome = () => homeOf('EDGE_GUARD_INDEXES', /^export\s+const\s+EDGE_GUARD_INDEXES\b/m);
const builderHome = () => homeOf('ensureEdgeGuardIndex', /^export\s+(?:async\s+)?function\s+ensureEdgeGuardIndex\b/m);

let declared;
before(async () => {
  const home = FILES.find(f => /^export\s+const\s+EDGE_GUARD_INDEXES\b/m.test(f.src));
  if (!home) return;
  const dist = home.file.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js');
  declared = (await import(pathToFileURL(join(REPO_ROOT, dist)).href)).EDGE_GUARD_INDEXES;
});

describe('the declaration', () => {
  it('exists once, and holds the guard index with its keys AND its options', () => {
    declarationHome();
    assert.ok(Array.isArray(declared) && declared.length >= 1, 'EDGE_GUARD_INDEXES is empty: a loop over it indexes nothing');
    const guard = declared.filter(ix => Object.keys(ix.keys).join() === MARKER);
    assert.equal(guard.length, 1, `exactly one entry keys on ${MARKER}`);
    assert.deepEqual(guard[0].keys, { [MARKER]: 1 });
    assert.equal(guard[0].options?.unique, true, 'the guard index is not UNIQUE, so nothing ever collides');
    assert.deepEqual(guard[0].options?.partialFilterExpression, { [MARKER]: { $type: 'string' } },
      'the partial filter must be { _functionalGuard: { $type: \'string\' } }: `$exists: true` indexes a null, and every unmarked edge would collide');
  });
});

describe('every build reads the declaration', () => {
  it('ensureEdgeGuardIndex iterates EDGE_GUARD_INDEXES and passes each entry\'s keys AND options to createIndex', () => {
    const home = builderHome();
    const body = bodyOf(home.src, 'ensureEdgeGuardIndex', 'ensureEdgeGuardIndex');
    assert.match(body, /\bEDGE_GUARD_INDEXES\b/, 'ensureEdgeGuardIndex does not read EDGE_GUARD_INDEXES');
    const call = body.match(/createIndex\s*\(\s*(\w+)\.keys\s*,\s*(\w+)\.options\s*\)/);
    assert.ok(call && call[1] === call[2],
      'ensureEdgeGuardIndex does not call createIndex(ix.keys, ix.options) with one entry: the options are spelled by hand');
    assert.doesNotMatch(body, /\bunique\s*:/, 'ensureEdgeGuardIndex spells `unique` itself');
    assert.doesNotMatch(body, /\bpartialFilterExpression\b/, 'ensureEdgeGuardIndex spells the partial filter itself');
  });

  it('initSpace and the ensureQueryIndexes pass both build the index through ensureEdgeGuardIndex', () => {
    const life = FILES.find(f => f.file === 'server/src/spaces/lifecycle.ts');
    const ensure = FILES.find(f => f.file === 'server/src/spaces/ensure-query-indexes.ts');
    assert.ok(life && ensure, 'lifecycle.ts or ensure-query-indexes.ts is gone: re-point this gate');
    const sites = [
      ['initSpace', bodyOf(life.src, 'initSpace', 'initSpace')],
      ['ensureQueryIndexes', bodyOf(ensure.src, 'ensureQueryIndexes', 'ensureQueryIndexes')],
    ];
    const missing = sites.filter(([, body]) => !/\bensureEdgeGuardIndex\(/.test(body)).map(([name]) => name);
    assert.deepEqual(missing, [], 'these build sites do not call ensureEdgeGuardIndex, so the index is missing from the space they build');
  });

  it('no createIndex anywhere in server/src names the marker, and no partial filter on it is written outside the declaration', () => {
    const declaring = declarationHome().file;
    const handBuilt = [];
    for (const { file, src } of FILES) {
      for (const m of src.matchAll(/createIndex\s*\(\s*\{[^)]*\b_functionalGuard\b/g)) handBuilt.push(`${file}: ${m[0].slice(0, 60)}`);
      if (file !== declaring) {
        for (const m of src.matchAll(/partialFilterExpression\s*:\s*\{[^}]*\b_functionalGuard\b/g)) handBuilt.push(`${file}: ${m[0].slice(0, 60)}`);
      }
    }
    assert.deepEqual(handBuilt, [], 'the guard index is built or its filter written by hand: take both from EDGE_GUARD_INDEXES');
  });
});
