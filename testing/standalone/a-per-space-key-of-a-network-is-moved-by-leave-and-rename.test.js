/**
 * Every map a network keeps by a space's local id is cleaned by the space leaving and moved by the space's rename (bundle-269, review
 * findings 1 and 2).
 *
 * ## What it prevents
 *
 * `NetworkConfig` keeps several maps keyed by the LOCAL id of a space (`schemaLayers`, `schemaLayerUnread`, `spaceOrigins`,
 * `rdfBaseConflicts`, the alias map `spaceMap`). A map added to the type but not named in `takeSpaceOutOfNetwork` leaves its entry behind
 * for good when a space leaves the network (a recorded RDF base conflict then refused every export of the space with nothing able to
 * clear it), and one not named in `applySpaceRenameToConfig` loses the entry on a rename (the same refusal lifted silently, and handed to a
 * space created under the old id). Both slips passed every test, because each is invisible until the other half is exercised.
 *
 * ## What it holds
 *
 * The scope is the type itself: every field of `NetworkConfig` declared as a `Record<string, ...>` (read from `types-networks.ts`, never a
 * list kept here). Each is named in `networks/take-space-out-of-network.ts` and in `spaces/rename.ts`, in code (comments are stripped
 * first: a sentence explaining the fix is no cleanup). The per-member marks (`PER_SPACE_WATERMARKS` on `NetworkMember`) are a different
 * rule with its own gates (`one-mark-loop.test.js`, `receive-marks-and-kept-marks-classify-every-mark.test.js`). The one exception is data:
 * `spaceMap` is keyed by the NETWORK's id for the space, and what keeps it is named by function in each file.
 *
 * It is proven on planted copies: a map added to the type (a copy of the repository's own `rdfBaseConflicts` line under another name), and
 * the real `rdfBaseConflicts` dropped from each file in turn.
 *
 * Run: node --test testing/standalone/a-per-space-key-of-a-network-is-moved-by-leave-and-rename.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TYPES = 'server/src/config/types-networks.ts';
const TAKE_OUT = 'server/src/networks/take-space-out-of-network.ts';
const RENAME = 'server/src/spaces/rename.ts';

/**
 * The maps `NetworkConfig` is allowed to leave out of the take-out or the rename by name, with what must be named in their place. Each has
 * a reason and a review date; an entry past its date fails the gate.
 */
const ALIASED = [
  {
    key: 'spaceMap', reviewBy: '2027-06-01',
    reason: 'keyed by the network\'s id for the space, not the local id; its entries are forgotten and retargeted by the alias helpers, which each file must name',
    takeOut: 'forgetSpaceAliases', rename: 'retargetSpaceAliases',
  },
];

/** The body of `export interface NetworkConfig { ... }` in comment-free source. */
function networkConfigBody(types) {
  const src = stripComments(types);
  const at = src.indexOf('export interface NetworkConfig');
  assert.ok(at >= 0, 'NetworkConfig is no longer declared in types-networks.ts: read the new place');
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(src.indexOf('{', at) + 1, i);
  }
  throw new Error('NetworkConfig has no closing brace');
}

/** The fields of the body declared as `Record<string, ...>`, at the top level of the interface. */
function recordKeys(body) {
  const keys = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const m = depth === 0 ? /^\s*([A-Za-z_]\w*)\??:\s*Record<string,/.exec(line) : null;
    if (m) keys.push(m[1]);
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  return keys;
}

/** What is not named: one line per key missing from the take-out or the rename, given the three sources. */
function unnamed(types, takeOut, rename) {
  const code = { take: stripComments(takeOut), rename: stripComments(rename) };
  const named = (src, word) => new RegExp(`\\b${word}\\b`).test(src);
  const problems = [];
  for (const key of recordKeys(networkConfigBody(types))) {
    const alias = ALIASED.find(a => a.key === key);
    const wantTake = alias ? alias.takeOut : key;
    const wantRename = alias ? alias.rename : key;
    if (!named(code.take, wantTake)) problems.push(`${key}: ${wantTake} is not named in ${TAKE_OUT}`);
    if (!named(code.rename, wantRename)) problems.push(`${key}: ${wantRename} is not named in ${RENAME}`);
  }
  return problems;
}

describe('every map a network keeps by a space id is cleaned on leave and moved on rename', () => {
  const types = read(TYPES);
  const takeOut = read(TAKE_OUT);
  const rename = read(RENAME);

  it('the scope is read from the type and holds the maps the fixes name', () => {
    const keys = recordKeys(networkConfigBody(types));
    for (const k of ['schemaLayers', 'schemaLayerUnread', 'spaceOrigins', 'rdfBaseConflicts', 'spaceMap']) assert.ok(keys.includes(k), `${k} is not read from NetworkConfig: ${keys}`);
  });

  it('the exceptions are explained and in date', () => {
    for (const a of ALIASED) {
      assert.ok(a.reason.length > 20, `${a.key} has no reason`);
      assert.ok(a.reviewBy > new Date().toISOString().slice(0, 10), `the exception for ${a.key} is past its review date ${a.reviewBy}: review it`);
      assert.ok(recordKeys(networkConfigBody(types)).includes(a.key), `the exception for ${a.key} names a field NetworkConfig no longer has: delete it`);
    }
  });

  it('each is named in the take-out and in the rename', () => {
    assert.deepEqual(unnamed(types, takeOut, rename), []);
  });

  it('a map added to the type and named in neither file is reported for both', () => {
    const line = types.split('\n').find(l => /^\s*rdfBaseConflicts\?:\s*Record<string,/.test(l));
    assert.ok(line, 'the plant\'s source line (rdfBaseConflicts) is gone from the type');
    const planted = types.replace(line, `${line}\n${line.replace('rdfBaseConflicts', 'plantedPerSpaceMap')}`);
    assert.deepEqual(unnamed(planted, takeOut, rename), [
      `plantedPerSpaceMap: plantedPerSpaceMap is not named in ${TAKE_OUT}`,
      `plantedPerSpaceMap: plantedPerSpaceMap is not named in ${RENAME}`,
    ]);
  });

  it('the real rdfBaseConflicts dropped from the take-out, or from the rename, is reported', () => {
    const without = (src) => src.replace(/\brdfBaseConflicts\b/g, 'droppedMap');
    assert.deepEqual(unnamed(types, without(takeOut), rename), [`rdfBaseConflicts: rdfBaseConflicts is not named in ${TAKE_OUT}`]);
    assert.deepEqual(unnamed(types, takeOut, without(rename)), [`rdfBaseConflicts: rdfBaseConflicts is not named in ${RENAME}`]);
  });

  it('a name that only a comment mentions is not a cleanup', () => {
    const commentOnly = takeOut.replace(/\brdfBaseConflicts\b/g, 'droppedMap') + '\n// rdfBaseConflicts are forgotten here\n';
    assert.deepEqual(unnamed(types, commentOnly, rename), [`rdfBaseConflicts: rdfBaseConflicts is not named in ${TAKE_OUT}`]);
  });
});
