/**
 * `graphNodes` must count the graph in the payload, not the graph the traversal reached.
 *
 * ## The defect
 *
 * All four traverse-capable search sites reported `graphNodes: graph.nodes` — the total across every seed the
 * walk visited. But the byte budget then chooses a PREFIX of the matches, so any seed it evicts takes its
 * subtree with it. The number described an answer the caller did not receive, and it was always too large.
 *
 * The integration guide already documented the correct behaviour — *"how many traversed nodes came back"* —
 * so this was a false statement in a reference, not an undocumented quirk. Two integration tests already
 * asserted the correct contract (`graphNodes === allNested(results).length`) and passed only because their
 * fixtures never truncate: a test that is true by luck of fixture size stops being true the day the fixture
 * grows, and gives no warning when it does.
 *
 * ## Why it is counted rather than tracked
 *
 * `countGraphNodes` walks the emitted structure, so it is right for both doors' shapes by construction —
 * REST puts `_graph` alongside the match, MCP nests the match under `record` — and it is the same function
 * the spill file uses to describe itself. That is not reuse for its own sake: the spill file had this exact
 * bug one layer down, where a count passed in beside a payload described a different set of records than the
 * payload did. A number derived FROM the thing it describes cannot disagree with it.
 *
 * ## What this gate does not cover
 *
 * That a subtree can still evict later MATCHES. That is the other half of the same tracker row and is a
 * decision rather than a defect: the product promises in nine places — including the UI in three locales —
 * that every returned record carries its COMPLETE graph, so trimming subtrees to keep more matches breaks a
 * stated guarantee. Filed as P-25.
 *
 * Run: node --test testing/standalone/graphnodes-counts-what-was-sent.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround } from './_structural-window.mjs';

const { countGraphNodes } = await import('../../server/dist/brain/graph-spill.js');

const DOORS = ['server/src/api/brain/search.ts', 'server/src/mcp/tools/search.ts'];

describe('countGraphNodes reads both doors shapes', () => {
  it('counts a REST-shaped payload, where _graph sits beside the match', () => {
    assert.equal(countGraphNodes([{ _id: 'a', _graph: [{}, {}] }, { _id: 'b', _graph: [{}] }]), 3);
  });

  it('counts an MCP-shaped payload, where the match is nested under `record`', () => {
    // The reason this is a recursive walk rather than a `.map(r => r._graph.length)`: the two doors put the
    // subtree at different depths, and a shape-specific counter would silently answer 0 for the other one.
    assert.equal(countGraphNodes([{ record: { _id: 'a', _graph: [{}, {}] } }]), 2);
  });

  it('answers 0 for matches with no graph, rather than throwing', () => {
    assert.equal(countGraphNodes([{ _id: 'a' }, { record: { _id: 'b' } }]), 0);
    assert.equal(countGraphNodes([]), 0);
  });
});

describe('every door counts what it sent', () => {
  it('finds all four report sites, so an empty sweep cannot pass', () => {
    const sites = DOORS.flatMap(d =>
      [...stripComments(readFileSync(d, 'utf8')).matchAll(/graphNodes:/g)].map(m => `${d}@${m.index}`));
    assert.equal(
      sites.length, 4,
      `expected four graphNodes emitters — recall and find_similar on each door — found ${sites.length}. `
      + 'The scan has broken, or a fifth search surface exists and needs the same treatment.',
    );
  });

  it('none of them reports the pre-budget total', () => {
    const stale = [];
    for (const door of DOORS) {
      const src = stripComments(readFileSync(door, 'utf8'));
      for (const m of src.matchAll(/graphNodes:/g)) {
        const stmt = statementAround(src, m.index, `${door} graphNodes`);
        if (/graph\.nodes/.test(stmt)) stale.push(`${door}@${m.index}`);
      }
    }
    assert.deepEqual(
      stale, [],
      '`graph.nodes` is the total the traversal REACHED, across every seed — including the seeds the byte '
      + 'budget then evicted. Reporting it describes an answer the caller did not receive.',
    );
  });

  it('each one counts its OWN envelope, not a neighbouring one', () => {
    /*
     * The mistake this catches is one I made writing the fix: both sites on a door were given
     * `countGraphNodes(budgeted.results)` by a blanket replace, and `similar` names its envelope
     * `itemsBudgeted`. TypeScript caught it here because the name was undefined — but had the two been named
     * alike, the compiler would have been happy and each door would have reported its sibling endpoint's
     * count, which is exactly the class of bug this whole file is about.
     */
    for (const door of DOORS) {
      const src = stripComments(readFileSync(door, 'utf8'));
      for (const m of src.matchAll(/graphNodes:\s*countGraphNodes\((\w+)\.results\)/g)) {
        const envelope = m[1];
        // The envelope named here must be the one this response body spreads its fields from.
        const body = statementAround(src, m.index, `${door} response body`);
        assert.match(
          body, new RegExp(`\\.\\.\\.${envelope}\\.fields`),
          `${door} reports \`${envelope}\`'s graph count in a response built from a different envelope`,
        );
      }
    }
  });

  it('the count is taken AFTER the budget, never before it', () => {
    // Counting the array handed TO `budgetedEnvelope` would reproduce the defect with a different expression:
    // the point is not which function counts, it is which array.
    for (const door of DOORS) {
      const src = stripComments(readFileSync(door, 'utf8'));
      for (const m of src.matchAll(/countGraphNodes\((\w+)\.results\)/g)) {
        const decl = src.indexOf(`const ${m[1]} = await budgetedEnvelope(`);
        assert.notEqual(
          decl, -1,
          `${door} counts \`${m[1]}.results\`, which is not the output of a budgeted envelope — so the count `
          + 'may describe records the budget removed',
        );
        assert.ok(decl < m.index, `${door}: the count must come after the budget that produced it`);
      }
    }
  });
});
