/**
 * An MCP tool and its REST route take the SAME parameters — on every pair that can be read, not on four.
 *
 * ## The hole this fills
 *
 * *"MCP and REST are ONE API with two doors"*, and `CLAUDE.md` is explicit that parameters count too, being
 * *"the half that hides"*. Two gates covered it and between them left most of that half unchecked:
 * `mcp-rest-parity.test.js` compares which CAPABILITIES exist, and `client-bodies-match-server.test.js`
 * compares parameters over a hard-coded map of four. `16-mcp.md` documents forty-six pairs.
 *
 * So a parameter gap was caught on four pairs and invisible on the rest — which is exactly what happened:
 * `update_space_schema` declared `whenDuePasses`, the dispatcher accepted it, and the handler dropped it
 * before the write while REST stored it. Nothing failed.
 *
 * ## Derived on both axes
 *
 * The PAIRING joins `MCP_TOOL_OPERATIONS` to the audit `ROUTE_RULES` on the shared operation name. The
 * PARAMETERS come from `_route-accept-keys.mjs`, which reads them out of each handler. Neither side is a
 * list here, so a tool or a route written next year is covered the day it lands.
 *
 * ## A route that cannot be read is SKIPPED, and the last case is what keeps that honest
 *
 * It is never treated as accepting nothing. "Accepts nothing" and "we could not tell" looking the same is
 * how a sweep reports clean about something nobody checked — see the five instrument errors recorded in
 * `_route-accept-keys.mjs`, four of which arrived looking like findings.
 *
 * Run: node --test testing/standalone/a-tool-and-its-route-take-the-same-parameters.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeAcceptKeys } from './_route-accept-keys.mjs';

const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const query = await import('../../server/dist/brain/query.js');
const bodySchemas = await import('../../server/dist/spaces/body-schemas.js');

/** Schemas the parser cannot see from inside a route file: supplied, never guessed. */
function exportedSets() {
  const sets = {
    QUERY_BODY_FIELDS: query.QUERY_BODY_FIELDS,
    RECALL_BODY_FIELDS: query.RECALL_BODY_FIELDS,
    TRAVERSE_BODY_FIELDS: query.TRAVERSE_BODY_FIELDS,
    FIND_SIMILAR_BODY_FIELDS: query.FIND_SIMILAR_BODY_FIELDS,
  };
  for (const [name, v] of Object.entries(bodySchemas)) {
    const shape = v?.shape ?? v?._def?.schema?.shape;
    if (shape) sets[name] = Object.keys(shape);
  }
  return sets;
}

/**
 * Keys that are TRANSPORT on one door and not a parameter on the other, so their absence is never a gap.
 *
 * `space` names the space in a tool argument and is a path segment on REST; `targetSpace` narrows a proxy
 * write and rides the query string. Neither is a body key, and neither is a capability.
 */
const TRANSPORT = new Set(['space', 'targetSpace']);

/**
 * Pairs that legitimately differ, each with its reason. Never a bare name — an exemption with no `why` is
 * indistinguishable from an omission, which is the rule `NOT_AREA_SCOPED` is written to.
 */
const DIFFER_ON_PURPOSE = new Map();

/**
 * Real gaps, not yet closed. **This list may only shrink**, and it is kept apart from the one above on
 * purpose: a defect filed beside a sanctioned difference stops looking like a defect.
 */
const KNOWN_GAP = new Map([
  ['sync_now:peerId', 'Q-20. `sync_now` syncs ONE peer — it validates the id against `list_peers` and calls '
    + '`runSyncForPeer` — and no REST route accepts `peerId` anywhere. `POST /api/notify/trigger` reads '
    + '`networkId` from the body and `wait` from the query, so a REST caller can sync a network and never a '
    + 'single peer. Found by this gate on its first honest run.'],
]);

/** `/api/spaces/:id/schema` → a concrete path an audit rule's regex can be tested against. */
const concrete = route => route.replace(/:[^/]+/g, 'x');

describe('a tool and its route take the same parameters', () => {
  const rows = routeAcceptKeys({ exportedSets: exportedSets() });

  const byOperation = new Map();
  for (const rule of ROUTE_RULES) {
    if (!byOperation.has(rule.operation)) byOperation.set(rule.operation, []);
    byOperation.get(rule.operation).push(rule);
  }

  const routesFor = (tool) => {
    const rules = byOperation.get(MCP_TOOL_OPERATIONS[tool]) ?? [];
    return rows.filter(r => rules.some(u => u.method === r.method && u.pattern.test(concrete(r.route))));
  };

  const declared = t => Object.keys(t.inputSchema({}).properties ?? {}).filter(k => !TRANSPORT.has(k));
  const paired = ALL_TOOLS
    .filter(t => MCP_TOOL_OPERATIONS[t.name])
    .map(t => ({ tool: t, routes: routesFor(t.name) }));

  it('the pairing found its subjects', () => {
    // A floor. An empty join passes every loop written over it while checking nothing — and this gate
    // exists because the one before it silently covered four pairs out of forty-six.
    const withRoutes = paired.filter(p => p.routes.length);
    assert.ok(withRoutes.length > 30,
      `only ${withRoutes.length} of ${paired.length} tools reached a route — the join is wrong, not the code`);
  });

  it('and enough of them are READABLE to be worth asserting over', () => {
    // The second half of the same floor. Pairing every tool to a route it cannot read would satisfy the
    // case above while comparing nothing at all.
    const readable = paired.filter(p => p.routes.some(r => r.keys));
    assert.ok(readable.length > 20,
      `only ${readable.length} tools reached a route whose parameters could be read — the parser is wrong`);
  });

  it('the four pairs the OLD gate covered are still covered', () => {
    /*
     * A new instrument must not quietly drop the coverage of the one it replaces, and this one did.
     *
     * `client-bodies-match-server.test.js` checked `query`, `recall`, `traverse` and `find_similar` over a
     * hard-coded map. Reading their sets here matched `unknownBodyFields(...)` with a negated-comma class,
     * which stops inside `Record<string, unknown>` — so the set name came back as `unknown`, the route
     * read as unresolved, and all four were SKIPPED while the gate reported a much bigger number.
     *
     * Naming them is the point: they are the ones somebody already decided were worth checking, and the
     * derived count above cannot notice four specific pairs going missing inside it.
     */
    const stillCovered = [];
    for (const name of ['query', 'recall', 'traverse', 'find_similar']) {
      const entry = paired.find(p => p.tool.name === name);
      const ok = entry && entry.routes.length && entry.routes.every(r => r.keys);
      if (!ok) stillCovered.push(`${name}: ${entry ? (entry.routes[0]?.unresolved ?? 'no route') : 'not paired'}`);
    }
    assert.deepEqual(stillCovered, [],
      'these were compared before this gate existed and are not being compared now: '
      + stillCovered.join('; '));
  });

  it('no tool declares a parameter its route will not accept', () => {
    const gaps = [];
    for (const { tool, routes } of paired) {
      /*
       * ALL of them readable, or none of this tool is compared.
       *
       * A capability can map to several routes, and taking the union of the readable ones is not a partial
       * answer — it is the wrong one. `chrono.list` covers `GET /chrono` and `GET /chrono/:id`; the list
       * route reads its filters field by field so the parser declines it, leaving the single-entry route to
       * answer for both, and `list_chrono`'s nine filters were reported as gaps against a route that was
       * never going to accept them.
       */
      if (!routes.length || routes.some(r => !r.keys)) continue;
      const readable = routes;
      // A tool may map to more than one route — the singular and bulk DELETE of a collection. A key any of
      // them accepts is accepted; refusing on the strictest would report the bulk route's silence as a gap.
      // BODY and QUERY together: which one a key arrives in is the route's transport decision.
      const accepted = new Set(readable.flatMap(r => [
        ...r.keys,
        ...(r.queryKeys ?? []),
        // PATH parameters. `delete_memory` declares `id` and the route spells it `/memories/:id` — the
        // record is named in the URL rather than in a body, which is a transport difference and not a
        // parameter the route refuses. Reported as sixteen gaps before this was here.
        ...[...r.route.matchAll(/:(\w+)/g)].map(m => m[1]),
      ]));
      for (const key of declared(tool)) {
        const pair = `${tool.name}:${key}`;
        if (accepted.has(key) || DIFFER_ON_PURPOSE.has(pair) || KNOWN_GAP.has(pair)) continue;
        gaps.push(`${tool.name} declares '${key}', accepted by none of: `
          + readable.map(r => `${r.method} ${r.route}`).join(', '));
      }
    }
    assert.deepEqual(gaps, [],
      'a tool argument its route drops is a 200 with the value silently missing, the quietest failure this '
      + `repo produces:\n  ${gaps.join('\n  ')}`);
  });

  it('every known gap still exists, so a closed one cannot sit here unnoticed', () => {
    // An exemption for a defect that has since been fixed is a licence for the next one to take its place.
    const fixed = [];
    for (const pair of KNOWN_GAP.keys()) {
      const [toolName, key] = pair.split(':');
      const entry = paired.find(p => p.tool.name === toolName);
      if (!entry || !entry.routes.length || entry.routes.some(r => !r.keys)) continue;
      const accepted = new Set(entry.routes.flatMap(r => [
        ...r.keys, ...(r.queryKeys ?? []), ...[...r.route.matchAll(/:(\w+)/g)].map(m => m[1]),
      ]));
      if (accepted.has(key)) fixed.push(pair);
    }
    assert.deepEqual(fixed, [], `these gaps are closed — delete their KNOWN_GAP rows: ${fixed.join(', ')}`);
  });

  it('the routes whose parameters cannot be read only get FEWER', () => {
    /*
     * The rest state their parameters in a shape the parser cannot follow: the body read field by field, a
     * partial destructure, a schema built from another, the whole request handed to a helper that reads it.
     * They are skipped above, so this is the only thing between "skipped" and "silently uncovered".
     *
     * The number lives here rather than in a title because it is meant to move, and a count in a title is a
     * second copy of a fact the code already holds.
     */
    const unreadable = rows.filter(r => r.method !== 'GET' && r.unresolved).length;
    assert.ok(unreadable <= 48,
      `${unreadable} mutating routes do not state their parameters readably, up from 48. Give the route a `
      + 'zod body schema, or gather the reads into one destructure.');
  });
});
