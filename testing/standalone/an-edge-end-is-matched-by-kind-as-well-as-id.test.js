/**
 * No brain module decides "is this edge's end record X" by id alone, in a query or in memory (Q-321).
 *
 * ## What it holds
 *
 * An edge end is an id AND a kind. The relink compared `edge.from === absorbedId` and queried `{ $or: [{ from: id }, { to: id }] }`, so a merge of an
 * entity moved the edges of a fact holding the same id. `brain/edge-ends-of-record.ts` is the one place the rule is spelled (`endIsRecord`,
 * `edgeEndsAt`, `endsOfRecord`, `relinkedEnds`); this gate derives every brain source and fails on either hand-written form outside it.
 *
 * ## The two forms, derived from the sources
 *
 *  - in memory: a `.from` / `.to` compared with `===` against an absorbed, entity, survivor or target id;
 *  - in a query: the clause `{ from: <id> }, { to: <id> }` as two bare alternatives.
 *
 * The floor: the scan read many brain files and the module's own four exports exist, so a renamed export or an empty listing cannot pass it. A
 * comparison that is NOT about a record's end (a self-loop test `edge.from === edge.to`, an edge's own `from === seedId` on a path) does not match.
 *
 * Run: node --test testing/standalone/an-edge-end-is-matched-by-kind-as-well-as-id.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/brain/edge-ends-of-record.ts';
const IN_MEMORY = /\.(?:from|to)\s*===\s*(?:absorbed|entity|survivor|target)\w*/g;
const IN_QUERY = /\{\s*from:\s*\w+\s*\}\s*,\s*\{\s*to:\s*\w+\s*\}/g;

describe('an edge end is matched by kind as well as id', () => {
  const sources = trackedSources('server/src/brain', { floor: 50, exclude: [MODULE] });

  it('the scan read the brain, and the module it points at has its four exports', () => {
    const mod = stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    for (const name of ['endIsRecord', 'edgeEndsAt', 'endsOfRecord', 'relinkedEnds']) {
      assert.match(mod, new RegExp(`export function ${name}\\b`), `${MODULE} no longer exports ${name}: re-anchor this gate`);
    }
    assert.ok(sources.length >= 50, `only ${sources.length} brain source(s) read`);
  });

  it('no brain module outside it compares an end by id alone', () => {
    const hits = [];
    for (const f of sources) {
      const code = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
      for (const re of [IN_MEMORY, IN_QUERY]) for (const m of code.matchAll(re)) hits.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(hits, [], 'an edge end is compared by id alone: ask `edge-ends-of-record.ts`, which matches the kind too (a fact holding an entity\'s id is not that entity)');
  });
});
