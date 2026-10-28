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
 * `schema_update` declared `whenDuePasses`, the dispatcher accepted it, and the handler dropped it
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
import { trackedSources } from './_sources.mjs';
import { CAPABILITIES } from './_capability-map.mjs';

const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { REST_ONLY_CAPABILITIES } = await import('../../server/dist/mcp/parity.js');
const query = await import('../../server/dist/brain/query.js');
const bodySchemas = await import('../../server/dist/spaces/body-schemas.js');
// The network acts' bodies (F-36): the routes parse with them, and so do the tools through the same acts. Every
// module in `networks/`, read from the tree rather than named, so an act file added next is not invisible here.
const networkActs = Object.assign({}, ...await Promise.all(trackedSources(['server/src/networks/*.ts'], { floor: 3 })
  .map(f => import(`../../${f.replace('server/src/', 'server/dist/').replace(/\.ts$/, '.js')}`))));

/** Schemas the parser cannot see from inside a route file: supplied, never guessed. */
function exportedSets() {
  const sets = {
    QUERY_BODY_FIELDS: query.QUERY_BODY_FIELDS,
    TRAVERSE_BODY_FIELDS: query.TRAVERSE_BODY_FIELDS,
    FIND_SIMILAR_BODY_FIELDS: query.FIND_SIMILAR_BODY_FIELDS,
  };
  for (const [name, v] of [...Object.entries(bodySchemas), ...Object.entries(networkActs)]) {
    const shape = v?.shape ?? v?._def?.schema?.shape;
    if (shape) sets[name] = Object.keys(shape);
  }
  return sets;
}

/**
 * Keys that are TRANSPORT on one door and not a parameter on the other, so their absence is never a gap.
 *
 * `space` names the space in a tool argument and is a path segment on REST. It is not a body key and not a capability.
 * (`targetSpace` is not here: it is a retired field refused by name on both doors, so a tool declaring it would be a gap.)
 */
const TRANSPORT = new Set(['space']);

/**
 * Pairs that legitimately differ, each with its reason. Never a bare name — an exemption with no `why` is
 * indistinguishable from an omission, which is the rule `NOT_AREA_SCOPED` is written to.
 */
const DIFFER_ON_PURPOSE = new Map([
  ['network_sync:networkId',
    'the same network under two spellings: the tool names it `networkId` beside `peerId`, and REST puts it in the '
    + 'path as `/networks/:id/sync`. The parser matches path parameters by name, and `id` is the path\'s generic name.'],
  ['list_spaces:counts',
    '`GET /api/spaces?counts=true` makes the per-space counts optional, REST\'s listing being often wanted cheap; the '
    + 'tool is the list an agent reads to choose a space, and ALWAYS carries the counts (its description says why: an '
    + 'empty space is not worth a recall). A tool argument for it would offer a listing the tool exists not to give.'],
]);

/**
 * Real gaps, not yet closed. **This list may only shrink**, and it is kept apart from the one above on
 * purpose: a defect filed beside a sanctioned difference stops looking like a defect.
 */
const KNOWN_GAP = new Map([
  // EMPTY, and it has been. The one row it held — `sync_now:peerId` — was closed by giving the REST side a
  // door that names a peer (`POST /api/networks/peers/:peerId/sync`), so the case below has nothing to
  // police yet. A row here is a defect somebody has not got to; the list may only shrink.
]);

/**
 * Pairings the subtraction would drop and must not, each with its reason (`tool <TAB> METHOD route`). Kept apart from the
 * two maps above because it is about WHICH ROUTES a tool is compared with, not about which parameters differ.
 */
const KEEP_PAIRING = new Map([
  ['schema_update\tPATCH /api/spaces/:id',
    'the tool\'s default mode MERGES types, which is this route\'s typeSchemas merge (`typeSchemasMode: "replace"` is the '
    + 'whole-map `PUT /api/spaces/:id/schema` the capability map gives it), and it declares the settings this route takes. '
    + 'Dropping it left only the PUT, whose body is the type map alone, and reported ten settings as gaps that are not: '
    + 'the route stays unreadable, so the tool stays outside the tool -> route case, as it was, until Q-646 classifies it.'],
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

  // A tool may name SEVERAL operations, because one capability's REST half can be more than one route —
  // `network_sync` is a full cycle or one named peer, and REST spells those apart because a path has to
  // name its subject. Reading only the first compared the tool against half of itself and reported
  // `peerId` as a parameter no route accepts.
  const operationsOf = (tool) => {
    const op = MCP_TOOL_OPERATIONS[tool];
    return op == null ? [] : (Array.isArray(op) ? op : [op]);
  };

  /*
   * THE PAIRING. An audit operation is shared by routes that are different capabilities (`space.list` is `list_spaces` AND
   * `space_meta`; `file.list` is `list_dir` AND the extract route; `file.read` is `read_file` AND the bytes download), so a
   * join through the operation alone pairs a tool with another tool's route. Compared in the route->tool direction that
   * reported the other tool's parameters as gaps in this one (`list_dir` "lacked" the extract route's `limit`), so the join is
   * SUBTRACTED, from the two registries that already say whose a route is: the capability map gives a route to a tool, and
   * `REST_ONLY_CAPABILITIES` says a route no tool answers. Neither is a list kept here.
   *
   * A tool the subtraction leaves with no route falls back to the routes the capability map gives it, and that is what pairs
   * `read_file` with `GET …/files/extract` (its bytes route is REST-only, so nothing else is left): the audit join alone
   * cannot reach it, because the extract route's operation is `file.list`.
   */
  const routeKey = r => `${r.method} ${r.route}`;
  const mapOwner = new Map(CAPABILITIES.map(([, tool, route]) => [route, tool]));
  const restOnly = new Set(REST_ONLY_CAPABILITIES.map(c => `${c.method} ${c.restEndpoint}`));
  /** Why a route the audit operation reaches is NOT this tool's, or `null` when it is. */
  const notThisToolsRoute = (tool, r) => {
    if (KEEP_PAIRING.has(`${tool}\t${routeKey(r)}`)) return null;
    const owner = mapOwner.get(routeKey(r));
    if (owner !== undefined && owner !== tool) return `the capability map gives it to ${owner}`;
    if (restOnly.has(routeKey(r))) return 'it is declared REST-only';
    return null;
  };
  const joinedRoutes = (tool) => {
    const rules = operationsOf(tool).flatMap(op => byOperation.get(op) ?? []);
    return rows.filter(r => rules.some(u => u.method === r.method && u.pattern.test(concrete(r.route))));
  };
  const routesFor = (tool) => {
    const kept = joinedRoutes(tool).filter(r => notThisToolsRoute(tool, r) === null);
    return kept.length ? kept : rows.filter(r => mapOwner.get(routeKey(r)) === tool);
  };

  const declared = t => Object.keys(t.inputSchema({}).properties ?? {}).filter(k => !TRANSPORT.has(k));
  const paired = ALL_TOOLS
    .filter(t => MCP_TOOL_OPERATIONS[t.name])
    .map(t => ({ tool: t, routes: routesFor(t.name) }));

  const pathParams = r => [...r.route.matchAll(/:(\w+)/g)].map(m => m[1]);
  const acceptedBy = routes => new Set(routes.flatMap(r => [...r.keys, ...(r.queryKeys ?? []), ...pathParams(r)]));

  /** Every `tool:param` a tool declares that none of its routes accepts: the tool -> route half, before any exemption. */
  const toolOnlyParams = () => paired.flatMap(({ tool, routes }) => {
    if (!routes.length || routes.some(r => !r.keys)) return [];
    const accepted = acceptedBy(routes);
    return declared(tool).filter(k => !accepted.has(k)).map(k => `${tool.name}:${k}`);
  });
  /** Every `tool:param` a paired route accepts that the tool does not declare: the route -> tool half, before any exemption. */
  const routeOnlyParams = () => paired.flatMap(({ tool, routes }) => {
    const have = new Set([...declared(tool), ...TRANSPORT]);
    return routes.filter(r => r.keys).flatMap(r => [...new Set([...r.keys, ...(r.queryKeys ?? [])])]
      .filter(k => !have.has(k) && !pathParams(r).includes(k)).map(k => `${tool.name}:${k}\t${routeKey(r)}`));
  });

  it('the pairing found its subjects', () => {
    // A floor. An empty join passes every loop written over it while checking nothing — and this gate
    // exists because the one before it silently covered four pairs out of forty-six.
    const withRoutes = paired.filter(p => p.routes.length);
    assert.ok(withRoutes.length > 30,
      `only ${withRoutes.length} of ${paired.length} tools reached a route — the join is wrong, not the code`);
  });

  it('a route the capability map gives to another tool never pairs through a shared operation', () => {
    /*
     * Derived from the two registries (`CAPABILITIES`, `REST_ONLY_CAPABILITIES`), with a floor: an empty set of dropped
     * pairings is a subtraction that does nothing, and every case below would then run over another tool's routes.
     * Seen red by deleting the `notThisToolsRoute` filter from `routesFor`.
     */
    const dropped = paired.flatMap(({ tool }) => joinedRoutes(tool.name)
      .map(r => ({ tool: tool.name, route: routeKey(r), why: notThisToolsRoute(tool.name, r) }))
      .filter(d => d.why !== null));
    assert.ok(dropped.length > 0,
      'no pairing was dropped — the audit join no longer reaches another tool\'s route, or the subtraction reads nothing');
    const kept = paired.flatMap(({ tool, routes }) => routes
      .filter(r => notThisToolsRoute(tool.name, r) !== null)
      .map(r => `${tool.name} is paired with ${routeKey(r)}: ${notThisToolsRoute(tool.name, r)}`));
    assert.deepEqual(kept, [], `a tool is compared against a route that is not its capability:\n  ${kept.join('\n  ')}`);
  });

  it('a tool the audit join cannot reach is paired through the capability map: read_file with the extract route', () => {
    const entry = paired.find(p => p.tool.name === 'read_file');
    assert.deepEqual(entry?.routes.map(routeKey), ['GET /api/brain/spaces/:spaceId/files/extract'],
      'read_file must be compared with its text route and not with the bytes download');
  });

  it('and enough of them are READABLE to be worth asserting over', () => {
    /*
     * The second half of the same floor. Pairing every tool to a route it cannot read would satisfy the
     * case above while comparing nothing at all.
     *
     * A PROPORTION, not a count, and the change is the point. It read `> 20`, calibrated when the surface
     * had 48 tools. A-4 folded three of them into others — each had a route, so each had been pairing — and
     * the count fell to 20 for a reason that was correct. A raw count turns every legitimate change to the
     * surface into a red gate, and the obvious repair is to lower the number, which is how a floor quietly
     * becomes decoration. The real ratio is measured, not guessed: 20 of 41 tools pair to a readable
     * route today, and it was 23 of 44 before the fold — about half, both times. The floor sits at 40%
     * because a BROKEN parser does not land near the real ratio, it lands near zero, so the gap between
     * 40% and 49% is slack for the surface changing rather than tolerance for a defect.
     */
    const readable = paired.filter(p => p.routes.some(r => r.keys || r.delegatesTo));
    assert.ok(readable.length > paired.length * 0.4,
      `only ${readable.length} of ${paired.length} tools reached a route whose parameters could be read `
      + '— the parser is wrong, not the code');
  });

  it('the four pairs the OLD gate covered are still covered', () => {
    /*
     * A new instrument must not quietly drop the coverage of the one it replaces, and this one did.
     *
     * `client-bodies-match-server.test.js` checked `query`, `recall`, `traverse` and `similar` over a
     * hard-coded map. Reading their sets here matched `unknownBodyFields(...)` with a negated-comma class,
     * which stops inside `Record<string, unknown>` — so the set name came back as `unknown`, the route
     * read as unresolved, and all four were SKIPPED while the gate reported a much bigger number.
     *
     * Naming them is the point: they are the ones somebody already decided were worth checking, and the
     * derived count above cannot notice four specific pairs going missing inside it.
     */
    /*
     * `filter` came OFF this list at `B-9` step 3c, and that is the fourth answer this case can get.
     *
     * It had a hand-written REST route with its own accepted-body set, which is what made it comparable
     * — and what made it worth comparing. The route is DELETED: `filter` is reachable only through the
     * generic `/api/<tool-name>` door, which registers no per-tool route at all, so there is no second
     * parameter list in existence for the tool's schema to drift from.
     *
     * That is not lost coverage, it is the coverage becoming unnecessary — the same argument the
     * `delegatesTo` branch below makes, one step further. `one-capability-is-one-shape` is what holds it
     * there: it fails if `filter` ever answers a legacy route again.
     */
    const stillCovered = [];
    for (const name of ['recall', 'graph_traverse', 'similar']) {
      const entry = paired.find(p => p.tool.name === name);
      /*
       * `delegatesTo` counts, and counts as the strongest of the three answers rather than as a let-off.
       * A route that hands its whole body to `callTool` has no parameter list to compare, because the
       * tool's `inputSchema` IS the list it is validated against — so there is nothing left that could
       * drift. `POST /api/brain/recall` became one of these when its four hundred lines collapsed onto the
       * shared module, and reading that as lost coverage would be exactly backwards.
       */
      const ok = entry && entry.routes.length && entry.routes.every(r => r.keys || r.delegatesTo);
      if (!ok) {
        const why = entry ? (entry.routes[0]?.unresolved ?? 'no route registered for it') : 'not paired';
        stillCovered.push(`${name}: ${why}`);
      }
    }
    assert.deepEqual(stillCovered, [],
      'these were compared before this gate existed and are not being compared now: '
      + stillCovered.join('; '));
  });

  it('a route that delegates to a tool delegates to the RIGHT tool', () => {
    /*
     * The one thing a delegating route can still get wrong, and the one thing nothing else would catch.
     *
     * Every check above stops comparing the moment a route says `delegatesTo`, on the argument that the
     * tool's schema is the route's contract. That argument holds only if the named tool is the capability
     * the route claims to be: `POST /api/brain/recall` forwarding to `filter` would validate cleanly,
     * answer 200, and be wrong about everything — with the parity sweep reporting it as covered.
     *
     * Derived from the registry rather than from a list of the routes that delegate today, so the second
     * and third collapses are checked by the commit that makes them.
     *
     * "Its own capability" is the AUDIT OPERATION, not the route's last path segment. The segment was the
     * first proxy, and it held while every collapsed route happened to share its tool's name — `recall`,
     * `similar`. `Q-109` collapsed `POST /spaces/:id/traverse` onto `graph_traverse`, a correct delegation
     * the segment rule reported as wrong. The operation is what both registries already say the capability
     * IS: `ROUTE_RULES` names the route's, `MCP_TOOL_OPERATIONS` the tool's, and neither was written for
     * this gate — so a route forwarding to a sibling tool (traverse to `similar`) still fails here.
     */
    const wrong = [];
    const delegating = rows.filter(r => r.delegatesTo);
    // A floor: `recall`, `similar` and `graph_traverse` delegate today. Zero delegating rows would pass the
    // loop below while checking nothing — the parser losing `callTool` looks exactly like no collapse yet.
    assert.ok(delegating.length >= 3,
      `only ${delegating.length} delegating route(s) found — the parser lost the callTool shape`);
    for (const row of delegating) {
      if (!ALL_TOOLS.some(t => t.name === row.delegatesTo)) {
        wrong.push(`${row.method} ${row.route} forwards to '${row.delegatesTo}', which is not a tool`);
        continue;
      }
      const routeOps = ROUTE_RULES
        .filter(u => u.method === row.method && u.pattern.test(concrete(row.route)))
        .map(u => u.operation);
      if (!routeOps.length) {
        // Unclassified is not "matches": a route the audit cannot name has no capability to compare against.
        wrong.push(`${row.method} ${row.route} forwards to '${row.delegatesTo}' but no audit rule names the route`);
        continue;
      }
      const toolOps = operationsOf(row.delegatesTo);
      if (!routeOps.some(op => toolOps.includes(op))) {
        wrong.push(`${row.method} ${row.route} (${routeOps.join('|')}) forwards to the '${row.delegatesTo}' `
          + `tool (${toolOps.join('|') || 'no operation'})`);
      }
    }
    assert.deepEqual(wrong, [],
      `a delegating route is only in parity if it delegates to its own capability:\n  ${wrong.join('\n  ')}`);
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
        // PATH parameters. `delete_fact` declares `id` and the route spells it `/facts/:id` — the
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

  it('no route accepts a parameter its tool lacks, on EVERY paired route', () => {
    /*
     * The half the cases above cannot see, and the one the rule's own example is about: `recall`'s filter, `/query`'s `skip`,
     * `network_sync`'s `wait`. A route that takes a parameter its tool does not leaves an agent with a narrower capability
     * than the REST caller has, and nothing says so — the tool never reported a thing it was never told.
     *
     * Over EVERY paired route that could be read, not a list of twins (`READ_TWINS` was one: it named `space_meta`). Body keys
     * and query keys together, minus the path's own parameters and `space`. A route that delegates to the tool has no key list
     * of its own, so it is skipped: its tool's schema IS the route's contract.
     */
    const readable = paired.filter(p => p.routes.some(r => r.keys));
    assert.ok(readable.length > paired.length * 0.4, `only ${readable.length} of ${paired.length} paired tools have a readable route`);
    const gaps = routeOnlyParams().filter(g => !DIFFER_ON_PURPOSE.has(g.split('\t')[0]) && !KNOWN_GAP.has(g.split('\t')[0]));
    assert.deepEqual(gaps, [],
      'a REST caller can say what an MCP caller cannot — each is `tool:parameter <TAB> the route that accepts it`. Add the '
      + 'parameter to the tool and its description in the same commit, or give the pair a reasoned DIFFER_ON_PURPOSE row:\n  '
      + gaps.join('\n  '));
  });

  it('every KEEP_PAIRING row still keeps a pairing the subtraction would drop', () => {
    const wouldDrop = new Set(ALL_TOOLS.flatMap(t => joinedRoutes(t.name)
      .filter(r => { const owner = mapOwner.get(routeKey(r)); return (owner !== undefined && owner !== t.name) || restOnly.has(routeKey(r)); })
      .map(r => `${t.name}\t${routeKey(r)}`)));
    const stale = [...KEEP_PAIRING.keys()].filter(k => !wouldDrop.has(k));
    assert.deepEqual(stale, [], `these rows keep a pairing nothing drops any more — delete them: ${stale.join('; ')}`);
    for (const [k, why] of KEEP_PAIRING) assert.ok(why.length >= 40, `${k}: no reason worth the name`);
  });

  it('every DIFFER_ON_PURPOSE and KNOWN_GAP row still names a real gap, and carries a reason', () => {
    // A row that no longer matches a gap is a licence for the next one to take its place — the check KNOWN_GAP always had,
    // which the sanctioned rows lacked until the pairing change deleted four of them by hand.
    const live = new Set([...toolOnlyParams(), ...routeOnlyParams().map(g => g.split('\t')[0])]);
    const stale = [];
    for (const [name, rows] of [['DIFFER_ON_PURPOSE', DIFFER_ON_PURPOSE], ['KNOWN_GAP', KNOWN_GAP]]) {
      for (const [pair, why] of rows) {
        if (typeof why !== 'string' || why.length < 40) stale.push(`${name} ${pair}: no reason worth the name`);
        if (!live.has(pair)) stale.push(`${name} ${pair}: matches no gap any more — delete the row`);
      }
    }
    assert.deepEqual(stale, [], stale.join('\n'));
  });

  it('a READ tool and its GET route take the same parameters, in BOTH directions', () => {
    /*
     * The pairing above joins through the audit `ROUTE_RULES`, and a read route has no audit rule — so every read
     * tool whose REST twin is a GET was outside this gate. `space_meta` was one: REST took `?resolve=` and the
     * tool had no `resolve` at all (`Q-168`), and nothing compared them because nothing could pair them.
     *
     * Both directions here, not just "the tool declares nothing the route drops": the Q-168 gap was the route
     * accepting a parameter the TOOL lacked, which the check above cannot see by construction.
     *
     * A list, because the join has no registry to read for GET routes — so it carries a floor, and every row
     * must still resolve to a readable route, or the row is stale rather than satisfied.
     */
    const READ_TWINS = new Map([
      ['space_meta', { method: 'GET', route: '/api/spaces/:id/meta' }],
    ]);
    assert.ok(READ_TWINS.size >= 1);
    const gaps = [];
    for (const [toolName, twin] of READ_TWINS) {
      const tool = ALL_TOOLS.find(t => t.name === toolName);
      const row = rows.find(r => r.method === twin.method && r.route === twin.route);
      if (!tool || !row || !row.keys) { gaps.push(`${toolName} ↔ ${twin.method} ${twin.route}: not readable`); continue; }
      const routeKeys = new Set([...row.keys, ...(row.queryKeys ?? [])]);
      const toolKeys = new Set(declared(tool));
      for (const k of toolKeys) if (!routeKeys.has(k)) gaps.push(`${toolName} declares '${k}', the route does not`);
      for (const k of routeKeys) if (!toolKeys.has(k)) gaps.push(`${twin.method} ${twin.route} accepts '${k}', ${toolName} does not`);
    }
    assert.deepEqual(gaps, [], `a read tool and its GET route disagree:\n  ${gaps.join('\n  ')}`);
  });

  it('the brain write routes are resolved through acceptedWriteKeys, and the tool declares exactly what they accept', async () => {
    /*
     * They were "unresolved" — twelve brain write routes the parser skipped because each reads its body through helpers (the
     * shared write options go through `ttlDaysError`, `dupeCheckOptsFromBody` and the connection helpers), so every case above
     * compared nothing about them and reported clean (bundle-128, design-v3 8.2 G3).
     *
     * After the change their accepted set IS `acceptedWriteKeys(operation)`, which `contract/write-accepts.ts` derives from the
     * paired tool's own `inputSchema`. **So this case is not the parity evidence and must not be read as it:** a tool compared
     * with a set derived from itself agrees by construction. It asserts that the routes are no longer skipped (the parser
     * resolves them through the judge's set) and that the two names for the set agree; the evidence that a ROUTE reads what its
     * tool declares is `a-route-reads-what-its-tool-declares.test.js`, which reads the handlers. `save_bulk` is outside it: its
     * top-level keys are refused in every mode and its items are judged per collection, by that gate.
     *
     * The parser (`_route-accept-keys.mjs`) names the source of a resolved route in `via`; a route resolved through the judge says
     * so there, which is the contract this case holds it to.
     */
    const judged = new Set(ROUTE_RULES
      .filter(r => r.method !== 'GET' && r.method !== 'DELETE' && r.pattern.source.includes('brain'))
      .map(r => r.operation)
      .filter(op => /\.(create|update|merge)$/.test(op)));
    const subjects = paired.filter(p => operationsOf(p.tool.name).some(op => judged.has(op)));
    assert.ok(subjects.length >= 11, `only ${subjects.length} brain write pairs were derived — the derivation is wrong, not the code`);

    const skipped = [];
    for (const { tool, routes } of subjects) {
      if (!routes.length) { skipped.push(`${tool.name}: no route registered for it`); continue; }
      for (const r of routes) {
        if (!r.keys || !/acceptedWriteKeys/.test(r.via ?? '')) {
          skipped.push(`${r.method} ${r.route}: ${r.unresolved ?? `resolved through ${r.via ?? 'nothing'}, not acceptedWriteKeys`}`);
        }
      }
    }
    assert.deepEqual(skipped, [], 'a brain write route is still unresolved, so no parity case above reads it');

    // The two spellings of the set agree. Imported here so its absence is part of the red output, not a reason this file cannot load.
    const { acceptedWriteKeys } = await import('../../server/dist/contract/write-accepts.js');
    const differing = [];
    for (const { tool, routes } of subjects) {
      const op = operationsOf(tool.name).find(o => judged.has(o));
      const want = [...acceptedWriteKeys(op)].sort();
      for (const r of routes) {
        const have = [...r.keys].sort();
        if (JSON.stringify(have) !== JSON.stringify(want)) differing.push(`${r.method} ${r.route}: route ${have.join(',')} | ${op} ${want.join(',')}`);
      }
    }
    assert.deepEqual(differing, []);
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
