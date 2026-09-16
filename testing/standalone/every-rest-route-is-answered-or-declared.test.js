/**
 * Every REST route is answered by an MCP tool, declared as a gap, or classified as not a capability.
 *
 * ## The finding this exists for
 *
 * `REST_ONLY_CAPABILITIES` is empty, `help()` reports that emptiness to every caller as a promise that MCP
 * and REST reach the same things — and it was **false in two places**: a file's original bytes, and every
 * one of the twenty network routes.
 *
 * **`mcp-rest-parity.test.js` could not have caught it.** It asserts both halves of every ROW: the REST
 * route exists, no MCP tool of that name exists. With zero rows it asserts nothing at all, for ever. That
 * is *A gate concludes about MORE than it checks* sitting directly under this repo's headline rule — the
 * title says the surfaces match, the body reads a list that is empty.
 *
 * ## So this one derives the subject set
 *
 * The routes come from the source (`mountedRoutes`), never from a list here, and **every one of them must
 * be classified**. There are three legitimate answers and a route may have exactly one:
 *
 *   - **ANSWERED** — an MCP tool does this. Named, and the tool is asserted to exist, so a renamed tool
 *     fails here rather than leaving a route silently unreachable.
 *   - **DECLARED** — a row in `REST_ONLY_CAPABILITIES`. A promise that something is missing, which
 *     `help()` publishes, and which `mcp-rest-parity.test.js` holds to being true in both directions.
 *   - **NOT A CAPABILITY** — with a reason. A peer-to-peer wire endpoint, a browser-session route, a probe.
 *     Not something an agent would ever want; the reason is what stops that becoming a dumping ground.
 *
 * A route in none of the three fails. That is the whole mechanism: a new route cannot be added without
 * somebody deciding which of the three it is, and "I did not think about MCP" stops being expressible.
 *
 * ## Why the classification is written out when the repo's rule says derive
 *
 * The SUBJECTS are derived; the JUDGEMENT cannot be. Whether `POST /api/spaces/:id/reembed` is the same
 * capability as `space_reindex` is a decision about meaning, and a heuristic that guessed it from the path
 * would be confidently wrong in both directions. What the rule actually forbids is a derived-and-then-
 * hand-listed SUBJECT set — a list of routes here would go stale the day a router gains one, silently.
 * This list cannot: an unclassified route fails, and a classification naming a route that no longer exists
 * fails too.
 *
 * Run: node --test testing/standalone/every-rest-route-is-answered-or-declared.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { CAPABILITIES, NOT_A_CAPABILITY, THE_TOOL_DOOR } from './_capability-map.mjs';

let ALL_TOOLS;
let REST_ONLY_CAPABILITIES;

before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
  ({ REST_ONLY_CAPABILITIES } = await import('../../server/dist/mcp/parity.js'));
});

const key = (r) => `${r.method} ${r.path}`;

/**
 * The classification, imported — `scripts/surface-matrix.mjs` renders the same two structures.
 *
 * Held in one module because it was held in three, and the copy nobody ran was the one being PUBLISHED:
 * it mapped the file-bytes route to `read_file`, the tool that returns extracted text, for a month.
 */
const ANSWERED = new Map(CAPABILITIES.map(([, tool, route]) => [route, tool]));

/** A key with a space is `METHOD /path`, exact. A key without one claims a whole subtree. */
const exemptionFor = (r) => {
  for (const [k, why] of NOT_A_CAPABILITY) {
    if (k.includes(' ')) { if (`${r.method} ${r.path}` === k) return why; continue; }
    if (r.path === k || r.path.startsWith(k + '/')) return why;
  }
  return undefined;
};

describe('the route set is real', () => {
  it('finds the whole API, not a prefix of it', () => {
    // The floor, stated twice on purpose: `mountedRoutes` throws below its own, and this one is about THIS
    // gate's subject. A scan that quietly halved would leave every classification below asserting nothing.
    const routes = mountedRoutes();
    assert.ok(routes.length >= 200,
      `only ${routes.length} routes found — the scan stopped matching, and every claim below is vacuous`);
  });
});

describe('every route is answered, declared, or classified', () => {
  it('none is unclassified', () => {
    const declared = new Set(REST_ONLY_CAPABILITIES.map(c => `${c.method} ${c.restEndpoint}`));
    const unclassified = [];
    for (const r of mountedRoutes()) {
      const k = key(r);
      // The generic tool door answers every tool at once, so it is classified by being itself.
      if (k === THE_TOOL_DOOR) continue;
      if (ANSWERED.has(k) || declared.has(k) || exemptionFor(r) !== undefined) continue;
      unclassified.push(k);
    }

    assert.deepEqual(unclassified.sort(), [],
      `${unclassified.length} route(s) are reachable over REST and nobody has said whether MCP reaches `
      + 'them. Each is one of three things and the gate cannot guess which: add it to ANSWERED with the '
      + 'tool that does it, to REST_ONLY_CAPABILITIES as a declared gap, or to NOT_A_CAPABILITY with the '
      + 'reason it is not one:\n  ' + unclassified.join('\n  '));
  });

  it('every tool named as an answer actually exists', () => {
    // Without this the map rots the moment a tool is renamed, and a renamed tool leaves the route it
    // answered silently unreachable while this gate still reports it covered.
    const names = new Set(ALL_TOOLS.map(t => t.name));
    const missing = [...new Set(ANSWERED.values())].filter(t => !names.has(t)).sort();
    assert.deepEqual(missing, [],
      `ANSWERED names ${missing.length} tool(s) that do not exist: ${missing.join(', ')}. The routes they `
      + 'claimed to cover are unreachable over MCP and this gate was reporting them covered.');
  });

  it('every classification names a route that still exists', () => {
    /*
     * The other direction, and the one that rots quietly. A classification for a deleted route is a
     * decision about nothing — and worse, it makes the numbers look complete while the route it described
     * has been replaced by one nobody classified.
     */
    const live = new Set(mountedRoutes().map(key));
    const livePaths = mountedRoutes().map(r => r.path);
    const stale = [...ANSWERED.keys()].filter(k => !live.has(k)).sort();
    assert.deepEqual(stale, [],
      `ANSWERED classifies ${stale.length} route(s) that no longer exist:\n  ${stale.join('\n  ')}`);

    const staleExempt = [...NOT_A_CAPABILITY.keys()].filter(k => k.includes(' ')
      ? !live.has(k)
      : !livePaths.some(path => path === k || path.startsWith(k + '/'))).sort();
    assert.deepEqual(staleExempt, [],
      `NOT_A_CAPABILITY exempts ${staleExempt.length} path(s) nothing serves:\n  ${staleExempt.join('\n  ')}`);
  });

  it('and no route is classified twice', () => {
    // Two answers for one route means one of them is wrong and nobody can tell which. In particular a
    // route that is BOTH answered by a tool and declared as a gap makes `help()` publish a lie.
    const declared = new Set(REST_ONLY_CAPABILITIES.map(c => `${c.method} ${c.restEndpoint}`));
    const both = [...ANSWERED.keys()].filter(k => declared.has(k)).sort();
    assert.deepEqual(both, [],
      `${both.length} route(s) are both answered by a tool and declared as a REST-only gap — `
      + `help() publishes the gap to every caller: ${both.join(', ')}`);
  });
});

describe('the declared gaps say something true', () => {
  it('every exemption carries a reason, not a blank', () => {
    const empty = [...NOT_A_CAPABILITY].filter(([, why]) => !why || why.trim().length < 20).map(([p]) => p);
    assert.deepEqual(empty, [],
      `these exemptions have no real reason: ${empty.join(', ')}. A blank is what turns this list into a `
      + 'place to put anything nobody wants to think about.');
  });
});
