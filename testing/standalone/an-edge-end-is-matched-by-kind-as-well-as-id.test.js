/**
 * No brain module decides "is this edge's end record X" by id alone, in a query or in memory (Q-321).
 *
 * ## What it holds
 *
 * An edge end is an id AND a kind. The relink compared `edge.from === absorbedId` and queried `{ $or: [{ from: id }, { to: id }] }`, so a merge of an
 * entity moved the edges of a fact holding the same id. `brain/edge-ends-of-record.ts` is the one place the rule is spelled (`endIsRecord`,
 * `edgeEndsAt`, `endsOfRecord`, `relinkedEnds`); this gate derives every brain source and fails on every hand-written form outside it.
 *
 * ## The forms, derived from the sources (any identifier, not a list of names)
 *
 *  - in memory: a `.from` / `.to` compared with `===` or `!==` against any identifier that is not itself a `.from` / `.to` (a comparison of two rows' ends,
 *    `edge.from === edge.to` or a link row's `row.from === r.from`, is not "is this end that record");
 *  - in a query, the two spellings of "either end is X": `{ from: x }, { to: y }` as two bare alternatives, and `{ from: { $in: xs } }, { to: { $in: ys } }`.
 *    A clause that carries its kind beside the id (`{ from: id, fromKind: kind }`) has a comma and so does not match.
 *
 * ## What is exempt, and why (each exemption is asserted to still hold a hit and to still say what its reason rests on)
 *
 * The two query sites below read edges by id alone ON PURPOSE. Each is a named exemption rather than a quiet gap, because this gate's title is a claim about
 * every brain module and a place it does not look is where the next copy would go:
 *
 *  - `frontier-query.ts` — the TRAVERSAL's frontier. A walk's node identity is the id throughout (its `visited` set, its frontier, the neighbour hydration
 *    and the shared window's `edgeTouchesFrontier`), so an edge query that matched the kind alone would leave the walk's own bookkeeping conflating the two
 *    records again. Making a traversal tell a fact from an entity that holds its id changes what a walk's node is, across both traversals and the shared
 *    reads: not a relink, and the owner's to decide. Until then a walk follows an edge by the id it reaches.
 *  - `forks.ts` — an aggregation `$match` that PRE-FILTERS edges by id; the stages after it refine each end by kind (`ends.kind`), so no edge is counted
 *    against a record it does not end at.
 *
 * The floor: the scan read many brain files and the module's own four exports exist, so a renamed export or an empty listing cannot pass it.
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
const IN_MEMORY = /\.(?:from|to)\s*[!=]==\s*(?!\w+\.(?:from|to)\b)\w+/g;
const IN_QUERY = /\{\s*from:\s*[^{},]+\}\s*,\s*\{\s*to:\s*[^{},]+\}/g;
const IN_QUERY_IN = /\{\s*from:\s*\{\s*\$in:[^}]*\}\s*\}\s*,\s*\{\s*to:\s*\{\s*\$in:[^}]*\}\s*\}/g;
const FORMS = [IN_MEMORY, IN_QUERY, IN_QUERY_IN];

/** file -> why it may read an edge's ends by id alone, and a pattern its text must still hold for the reason to be true. */
const EXEMPT = {
  'server/src/brain/frontier-query.ts': { anchor: /frontierEdgeQuery/, why: 'a traversal\'s node identity is the id throughout (visited set, frontier, neighbour hydration), so a kind match in this one query would leave the walk conflating them; what a walk\'s node is belongs to the owner' },
  'server/src/brain/forks.ts': { anchor: /'ends\.kind': kind/, why: 'an aggregation pre-filter by id, refined by kind in the stages that follow (`ends.kind`)' },
};

describe('an edge end is matched by kind as well as id', () => {
  const sources = trackedSources('server/src/brain', { floor: 50, exclude: [MODULE] });
  const hitsOf = (f) => {
    const code = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
    return FORMS.flatMap(re => [...code.matchAll(re)].map(m => m[0]));
  };

  it('the scan read the brain, and the module it points at has its four exports', () => {
    const mod = stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    for (const name of ['endIsRecord', 'edgeEndsAt', 'endsOfRecord', 'relinkedEnds']) {
      assert.match(mod, new RegExp(`export function ${name}\\b`), `${MODULE} no longer exports ${name}: re-anchor this gate`);
    }
    assert.ok(sources.length >= 50, `only ${sources.length} brain source(s) read`);
  });

  it('no brain module outside it compares an end by id alone, but the reasoned exemptions', () => {
    const hits = [];
    for (const f of sources) {
      if (EXEMPT[f]) continue;
      for (const hit of hitsOf(f)) hits.push(`${f}: ${hit}`);
    }
    assert.deepEqual(hits, [], 'an edge end is compared by id alone: ask `edge-ends-of-record.ts`, which matches the kind too (a fact holding an entity\'s id is not that entity)');
  });

  it('each exemption is a file that still reads an end by id alone, and still holds what its reason rests on', () => {
    for (const [f, { anchor, why }] of Object.entries(EXEMPT)) {
      assert.ok(sources.includes(f), `${f} is exempt but is no longer a brain source: remove the exemption`);
      assert.ok(hitsOf(f).length > 0, `${f} no longer reads an end by id alone: remove the exemption (${why})`);
      assert.match(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')), anchor, `${f} no longer holds what its exemption rests on (${why})`);
    }
  });
});
