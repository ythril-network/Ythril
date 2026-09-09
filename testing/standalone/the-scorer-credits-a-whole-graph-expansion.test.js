/**
 * A result's rank is credited to everything it BROUGHT BACK, however deep the expansion nested it.
 *
 * ## The defect this exists for
 *
 * `turnRanks` decides which source turns a benchmark result covers, and its own docblock states the rule:
 * *"A record's graph expansions carry that record's own rank, because they were returned as part of its
 * payload and a caller reading result 1 reads them with it."* It descended exactly one level and stopped.
 *
 * The shape is why. A recall answer nests a **wrapper** — `{ edge, node, paths, _graph }` — and the children
 * of a node hang off the WRAPPER's `_graph`, not off `node._graph`. Reading `g.node` and then recursing into
 * that node's `_graph` therefore finds nothing below hop 1, silently, for any depth.
 *
 * What it cost: every graph rung ever measured. Probed against a live instance, a recall at `depth: 2` with
 * `includeMemories: true` returns 10 seeds, 18 subject entities and **92 linked memories** — and the scorer
 * saw the 18 and none of the 92. So `s0wl`, the rung whose entire claim is that a match walks to a shared
 * subject and back out to a window in another session, was scored as though the walk had returned nothing.
 * It reported 50.3% against the un-walked control's 50.8% and read as "linking does not help".
 *
 * The failure is invisible from every number in the report, which is why it needs a test rather than a
 * comment: a scorer that credits too little produces a plausible score, and a plausible score is never
 * questioned.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { turnRanks } from '../../benchmarks/harness/turn-ranks.mjs';

/** A recall result, shaped the way the REST door actually returns one. */
const seed = (turn, graph) => ({ _id: `m-${turn}`, properties: { turn }, ...(graph ? { _graph: graph } : {}) });
/** A nested node, wrapped the way `nestNeighbours` wraps one. */
const wrap = (node, children) => ({
  edge: { label: 'memory.entityIds' }, paths: [], node, ...(children ? { _graph: children } : {}),
});
const entity = id => ({ _id: id, name: id, type: 'subject' });
const memory = turn => ({ _id: `m-${turn}`, fact: 'x', properties: { turn } });

describe('what a result covers', () => {
  test('the result itself is at its own rank', () => {
    const ranks = turnRanks([seed('D1:1'), seed('D2:2')]);
    assert.equal(ranks.get('D1:1'), 1);
    assert.equal(ranks.get('D2:2'), 2);
  });

  test('a turn named by a record covering several is credited for each', () => {
    const ranks = turnRanks([seed('D1:1,D1:2,D1:3')]);
    for (const id of ['D1:1', 'D1:2', 'D1:3']) assert.equal(ranks.get(id), 1);
  });

  test('a node nested one level below the result carries the result\'s rank', () => {
    const ranks = turnRanks([seed('D1:1', [wrap(memory('D9:4'))])]);
    assert.equal(ranks.get('D9:4'), 1, 'a hop-1 expansion was already credited before this gate');
  });

  test('A NODE NESTED TWO LEVELS DOWN CARRIES IT TOO', () => {
    /*
     * The case the scorer could not see. This is the exact shape of a linked-window answer: the match is a
     * window, hop 1 is the shared subject it names, and hop 2 is a window in ANOTHER session that names the
     * same subject. The children hang off the wrapper, which is what the old walk stepped past.
     */
    const ranks = turnRanks([
      seed('D1:1', [wrap(entity('pottery'), [wrap(memory('D18:7')), wrap(memory('D22:2'))])]),
    ]);
    assert.equal(ranks.get('D18:7'), 1, 'a hop-2 linked record must carry the rank of the result that returned it');
    assert.equal(ranks.get('D22:2'), 1);
  });

  test('depth is not a limit — a chain keeps the rank all the way down', () => {
    // Asserts the RULE rather than one depth: a case naming hop 2 alone would pass a walk hard-coded to two.
    const ranks = turnRanks([
      seed('D1:1', [wrap(entity('a'), [wrap(entity('b'), [wrap(memory('D30:9'))])])]),
    ]);
    assert.equal(ranks.get('D30:9'), 1);
  });

  test('first appearance wins, so a turn reached twice keeps its best rank', () => {
    const ranks = turnRanks([
      seed('D1:1', [wrap(entity('a'), [wrap(memory('D5:5'))])]),
      seed('D5:5'),
    ]);
    assert.equal(ranks.get('D5:5'), 1, 'reached at rank 1 through a walk, it must not be demoted to rank 2');
  });

  test('the out-of-band coverage map wins over a record\'s own property, at every depth', () => {
    // A rung that keeps its turn ids outside the corpus reports them by record id instead. That has to work
    // for a nested node too, or a clean-corpus rung scores zero on everything its walk returned.
    const covers = new Map([['m-nested', ['D40:1', 'D40:2']]]);
    const nested = { _id: 'm-nested', fact: 'x' };
    const ranks = turnRanks([seed('D1:1', [wrap(entity('a'), [wrap(nested)])])], covers);
    assert.equal(ranks.get('D40:1'), 1);
    assert.equal(ranks.get('D40:2'), 1);
  });
});
