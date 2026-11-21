/**
 * An MCP tool and its REST route take the SAME parameters — on every pair that can be read, not on four.
 *
 * ## The hole this fills
 *
 * *"MCP and REST are ONE API with two doors"*, and the y-flows convention `convention-ythril-both-doors-same-parameters` is explicit that parameters count too, being
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
import {
  loadDoorWorld, doorPairing, keyPairs, declaredKeys, toolOnlyKeys, routeOnlyKeys, acceptedKeys, operationsOf, concrete, routeKey, KEEP_PAIRING,
} from '../../tools/flow-checks/_door-pairs.mjs';

// The tool registry, the routes' accepted keys, the pairing and its subtraction are read by `tools/flow-checks/_door-pairs.mjs`, the one place that
// holds them (the door-parity flow-check probes read the same). What stays here is this gate's sanctioned differences and its floors.
const world = await loadDoorWorld();
const { rows, ROUTE_RULES } = world;

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
  ['import_rdf:document',
    'the RDF document is the REST route\'s request BODY (a stream the act reads into its spool under its bounds, its media type in `Content-Type`), '
    + 'so no key names it; an MCP call has no stream, so the tool takes the same bytes inline as `document`. Every other parameter is one name '
    + 'on both doors, in the query on REST.'],
  ['import_schema_rdf:document',
    'the same shape as `import_rdf` (Q-754): the schema file is the REST route\'s request body, read under the door\'s bounds with its media type '
    + 'in `Content-Type`; the tool takes the same bytes inline as `document`. Every other parameter is one name on both doors, in the query on REST.'],
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

describe('a tool and its route take the same parameters', () => {
  const { joinedRoutes, whyNotThisToolsRoute, wouldDrop } = doorPairing(world);
  const paired = keyPairs(world);

  /** Every `tool:param` a tool declares that none of its routes accepts: the tool -> route half, before any exemption. */
  const toolOnlyParams = () => paired.flatMap(pair => toolOnlyKeys(pair).map(k => `${pair.tool}:${k}`));
  /** Every `tool:param` a paired route accepts that the tool does not declare: the route -> tool half, before any exemption. */
  const routeOnlyParams = () => paired.flatMap(pair => routeOnlyKeys(pair).map(({ key, route }) => `${pair.tool}:${key}\t${routeKey(route)}`));

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
     * Seen red by deleting the `whyNotThisToolsRoute` filter from `routesFor` in `_door-pairs.mjs`.
     */
    const dropped = paired.flatMap(({ tool }) => joinedRoutes(tool)
      .map(r => ({ tool, route: routeKey(r), why: whyNotThisToolsRoute(tool, r) }))
      .filter(d => d.why !== null));
    assert.ok(dropped.length > 0,
      'no pairing was dropped — the audit join no longer reaches another tool\'s route, or the subtraction reads nothing');
    const kept = paired.flatMap(({ tool, routes }) => routes
      .filter(r => whyNotThisToolsRoute(tool, r) !== null)
      .map(r => `${tool} is paired with ${routeKey(r)}: ${whyNotThisToolsRoute(tool, r)}`));
    assert.deepEqual(kept, [], `a tool is compared against a route that is not its capability:\n  ${kept.join('\n  ')}`);
  });

  it('a tool the audit join cannot reach is paired through the capability map: read_file with the extract route', () => {
    const entry = paired.find(p => p.tool === 'read_file');
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
      const entry = paired.find(p => p.tool === name);
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
      if (!world.tools.has(row.delegatesTo)) {
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
      const toolOps = operationsOf(world, row.delegatesTo);
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
    for (const pair of paired) {
      /*
       * ALL of a tool's routes readable, or none of this tool is compared (`toolOnlyKeys`).
       *
       * A capability can map to several routes, and taking the union of the readable ones is not a partial
       * answer — it is the wrong one. `chrono.list` covers `GET /chrono` and `GET /chrono/:id`; the list
       * route reads its filters field by field so the parser declines it, leaving the single-entry route to
       * answer for both, and `list_chrono`'s nine filters were reported as gaps against a route that was
       * never going to accept them.
       *
       * A tool may map to more than one route — the singular and bulk DELETE of a collection. A key any of
       * them accepts is accepted; refusing on the strictest would report the bulk route's silence as a gap.
       * BODY and QUERY together: which one a key arrives in is the route's transport decision. PATH
       * parameters too: `delete_fact` declares `id` and the route spells it `/facts/:id` — the record is
       * named in the URL rather than in a body, which is a transport difference and not a parameter the
       * route refuses. Reported as sixteen gaps before path parameters were counted.
       */
      for (const key of toolOnlyKeys(pair)) {
        if (DIFFER_ON_PURPOSE.has(`${pair.tool}:${key}`) || KNOWN_GAP.has(`${pair.tool}:${key}`)) continue;
        gaps.push(`${pair.tool} declares '${key}', accepted by none of: `
          + pair.routes.map(r => `${r.method} ${r.route}`).join(', '));
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
      const entry = paired.find(p => p.tool === toolName);
      if (!entry || !entry.routes.length || entry.routes.some(r => !r.keys)) continue;
      if (acceptedKeys(entry.routes).has(key)) fixed.push(pair);
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
    const dropped = wouldDrop([...world.tools.keys()]);
    const stale = [...KEEP_PAIRING.keys()].filter(k => !dropped.has(k));
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
      const tool = world.tools.get(toolName);
      const row = rows.find(r => r.method === twin.method && r.route === twin.route);
      if (!tool || !row || !row.keys) { gaps.push(`${toolName} ↔ ${twin.method} ${twin.route}: not readable`); continue; }
      const routeKeys = new Set([...row.keys, ...(row.queryKeys ?? [])]);
      const toolKeys = new Set(declaredKeys(tool));
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
    const subjects = paired.filter(p => operationsOf(world, p.tool).some(op => judged.has(op)));
    assert.ok(subjects.length >= 11, `only ${subjects.length} brain write pairs were derived — the derivation is wrong, not the code`);

    const skipped = [];
    for (const { tool, routes } of subjects) {
      if (!routes.length) { skipped.push(`${tool}: no route registered for it`); continue; }
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
      const op = operationsOf(world, tool).find(o => judged.has(o));
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
