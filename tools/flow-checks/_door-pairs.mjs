/**
 * A tool and the route that does the same thing, read side by side from the code: the one reading under the two door-parity flow-check probes
 * (`check-i-integration-deep-parameters-match-both-doors`, `check-i-performance-deep-caps-match-both-doors`).
 *
 * ## What it prevents
 *
 * A probe that compares the two doors of a capability and answers about a smaller set than the doors have. Three things make that happen, and
 * each is closed here so no probe built on it can drop it:
 *
 * - **A stale or missing build.** The tool registry and the zod schemas are read from `server/dist`; after an edit to the source the old build
 *   answers happily. `loadDoorWorld` asks `_built-registry.mjs` first, so a stale build is `cannot answer`, never a verdict about the old one.
 * - **A route that cannot be read taken for a route that accepts nothing.** `routeAcceptKeys` answers `{ keys }`, `{ delegatesTo }` or
 *   `{ unresolved }`. A route whose keys are not readable, or that hands its body to the tool dispatcher (the tool's schema IS its contract),
 *   leaves the key comparison and is COUNTED (`unreadable`, `delegating`); the count is in every verdict and a floor refuses a reading that lost
 *   most of the surface.
 * - **A tool compared with another tool's route.** An audit operation is shared by routes that are different capabilities (`space.list` is
 *   `list_spaces` and `space_meta`), so a join through the operation alone pairs a tool with a stranger's route. The pairing is the audit join
 *   MINUS what the capability map gives to another tool or declares REST-only, and a tool left with no route falls back to the map's own routes.
 *
 * ## Where everything comes from, never a list in this file
 *
 * Pairs: `MCP_TOOL_OPERATIONS` and the audit `ROUTE_RULES` (the shared operation name), the capability map (`testing/standalone/_capability-map.mjs`)
 * and `REST_ONLY_CAPABILITIES`. A tool's keys and bounds: its `inputSchema`. A route's keys: the handler (`_route-accept-keys.mjs`). A route's
 * bounds: the exported zod schemas its handler reaches through the call graph (`_call-graph.mjs`, `_validator-schemas.mjs`). The one pairing
 * the subtraction would wrongly drop is `KEEP_PAIRING`, with its reason; a row that no longer keeps a pairing is a problem (`staleKeepRows`).
 *
 * The standalone gates `a-tool-and-its-route-take-the-same-parameters` and `a-tool-and-its-route-agree-on-bounds` read their pairs, the pairing
 * subtraction, the accepted keys and the bound normalisation from here, so the suite and the flow-check probes (what a loop run asks when it
 * cannot start the suite) hold one rule. What stays in each test is its own sanctioned differences and its floors.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, SERVER_CODE_ROOTS, SERVER_SOURCE_ROOT, trackedSources } from '../../testing/standalone/_sources.mjs';
import { builtRegistry } from './_built-registry.mjs';
import { CannotAnswer } from './_verdict.mjs';

const fromTesting = (f) => import(pathToFileURL(join(REPO_ROOT, 'testing', 'standalone', f)).href);
const fromDist = (f) => import(pathToFileURL(join(REPO_ROOT, 'server', 'dist', f)).href);

/**
 * Keys that are transport on one door and not a parameter on the other, so their absence is never a gap: `space` names the space in a tool
 * argument and is a path segment on REST. (`targetSpace` is not here: it is a retired field refused by name on both doors, so a tool declaring it
 * would be a gap.)
 */
export const TRANSPORT = new Set(['space']);

/** The bound keys a node can carry; split between the two probes: caps are upper bounds, the rest are floors and shape. */
export const CAP_KEYS = ['maximum', 'maxLength', 'maxItems'];
export const FLOOR_KEYS = ['minimum', 'minLength', 'minItems'];

/**
 * Pairings the subtraction would drop and must not, each with its reason (`tool<TAB>METHOD route`). About WHICH ROUTES a tool is compared with.
 */
export const KEEP_PAIRING = new Map([
  ['schema_update\tPATCH /api/spaces/:id',
    'the tool\'s default mode MERGES types, which is this route\'s typeSchemas merge (`typeSchemasMode: "replace"` is the whole-map `PUT /api/spaces/:id/schema` '
    + 'the capability map gives it), and it declares the settings this route takes. Dropping it left only the PUT, whose body is the type map alone, and reported '
    + 'ten settings as gaps that are not: the route stays unreadable, so the tool stays outside the tool -> route case, as it was, until Q-646 classifies it.'],
]);

/** `/api/spaces/:id/schema` as a concrete path an audit rule's regex can be tested against. */
export const concrete = (route) => route.replace(/:[^/]+/g, 'x');
export const routeKey = (r) => `${r.method} ${r.route ?? r.path}`;

/** One node's bounds normalised so two spellings of one rule compare equal (an integer's exclusive bound is the next inclusive one, a union is its loosest branch). */
export function boundsOf(node) {
  if (!node || typeof node !== 'object') return {};
  const all = [...CAP_KEYS, ...FLOOR_KEYS];
  const branches = (node.anyOf ?? node.oneOf)?.filter((b) => b.type !== 'null');
  if (branches?.length) {
    const each = branches.map(boundsOf);
    const out = {};
    for (const k of all) {
      if (each.some((b) => b[k] === undefined)) continue;
      out[k] = k.startsWith('min') ? Math.min(...each.map((b) => b[k])) : Math.max(...each.map((b) => b[k]));
    }
    const enums = each.map((b) => b.enum);
    if (enums.every(Boolean)) out.enum = [...new Set(enums.flat())].sort();
    return out;
  }
  const out = {};
  for (const k of all) if (node[k] !== undefined) out[k] = node[k];
  const integer = [node.type].flat().includes('integer');
  if (node.exclusiveMinimum !== undefined) out.minimum = integer ? node.exclusiveMinimum + 1 : node.exclusiveMinimum;
  if (node.exclusiveMaximum !== undefined) out.maximum = integer ? node.exclusiveMaximum - 1 : node.exclusiveMaximum;
  if (['uri', 'url', 'email'].includes(node.format)) out.minLength = Math.max(out.minLength ?? 0, 1);
  const e = node.enum ?? node.items?.enum;
  if (Array.isArray(e)) out.enum = [...e].sort();
  return out;
}

/** The comparable value of `attr` for one parameter: a bound, the enum, the default, or whether it is required. */
export function attributeOf(attr, schema, node, param) {
  if (attr === 'required') return (schema.required ?? []).includes(param);
  if (attr === 'default') return node?.default;
  return boundsOf(node)[attr];
}

/**
 * Everything the two probes read, once: the registries, the accepted keys of every route, the zod schemas and the call-graph index. A missing or
 * stale build is `cannot answer` before anything else is imported.
 */
export async function loadDoorWorld() {
  await builtRegistry();
  const [{ routeAcceptKeys }, validators, { CAPABILITIES }, { mountedRoutesWithSource }, { delegationOf }, graph] = await Promise.all([
    fromTesting('_route-accept-keys.mjs'), fromTesting('_validator-schemas.mjs'), fromTesting('_capability-map.mjs'),
    fromTesting('_routes.mjs'), fromTesting('_delegating-routes.mjs'), fromTesting('_call-graph.mjs'),
  ]);
  const [{ ROUTE_RULES }, { MCP_TOOL_OPERATIONS }, { REST_ONLY_CAPABILITIES }, query, bodySchemas, { BOUND_BY_FIELD }] = await Promise.all([
    fromDist('audit/middleware.js'), fromDist('mcp/audit-map.js'), fromDist('mcp/parity.js'), fromDist('brain/query.js'),
    fromDist('spaces/body-schemas.js'), fromDist('util/request-bounds.js'),
  ]);
  // The network acts' bodies: the routes parse with them and so do the tools. Every module of `networks/`, read from the tree.
  const networkActs = Object.assign({}, ...await Promise.all(
    trackedSources([`${SERVER_SOURCE_ROOT}/networks/*.ts`], { floor: 3 }).map((f) => fromDist(f.replace(`${SERVER_SOURCE_ROOT}/`, '').replace(/\.ts$/, '.js'))),
  ));
  const exportedSets = { QUERY_BODY_FIELDS: query.QUERY_BODY_FIELDS, TRAVERSE_BODY_FIELDS: query.TRAVERSE_BODY_FIELDS, FIND_SIMILAR_BODY_FIELDS: query.FIND_SIMILAR_BODY_FIELDS };
  for (const [name, v] of [...Object.entries(bodySchemas), ...Object.entries(networkActs)]) {
    const shape = v?.shape ?? v?._def?.schema?.shape;
    if (shape) exportedSets[name] = Object.keys(shape);
  }
  const tools = validators.toolValidators();
  const zods = new Map((await validators.zodValidators()).map((z) => [z.name, z]));
  const index = graph.moduleIndex(SERVER_CODE_ROOTS);
  return {
    rows: routeAcceptKeys({ exportedSets }), tools: new Map(tools.map((v) => [v.tool.name, v])), zods, index, graph,
    ROUTE_RULES, MCP_TOOL_OPERATIONS, REST_ONLY_CAPABILITIES, CAPABILITIES, BOUND_BY_FIELD, routes: mountedRoutesWithSource(), delegationOf,
  };
}

/** Tool name to its audit operations, as an array (a tool may name several). */
export const operationsOf = (world, tool) => {
  const op = world.MCP_TOOL_OPERATIONS[tool];
  return op == null ? [] : (Array.isArray(op) ? op : [op]);
};

/**
 * The pairing subtraction, read once from the two registries that already say whose a route is, so `keyPairs`, `staleKeepRows` and the standalone gate
 * cannot differ: `joinedRoutes(tool)` is the audit join (every route whose audit operation is one of the tool's), `whyNotThisToolsRoute(tool, route)`
 * says why such a route is another capability's (`null` when it is the tool's, or `KEEP_PAIRING` keeps it), `routesFor(tool)` is the join minus those, or
 * the routes the capability map gives the tool when nothing is left. `wouldDrop` is every `tool<TAB>METHOD route` the subtraction drops with no `KEEP_PAIRING` row.
 */
export function doorPairing(world) {
  const byOperation = new Map();
  for (const rule of world.ROUTE_RULES) byOperation.set(rule.operation, [...(byOperation.get(rule.operation) ?? []), rule]);
  const mapOwner = new Map(world.CAPABILITIES.map(([, tool, route]) => [route, tool]));
  const restOnly = new Set(world.REST_ONLY_CAPABILITIES.map((c) => `${c.method} ${c.restEndpoint}`));
  const strangerWhy = (tool, r) => {
    const owner = mapOwner.get(routeKey(r));
    if (owner !== undefined && owner !== tool) return `the capability map gives it to ${owner}`;
    if (restOnly.has(routeKey(r))) return 'it is declared REST-only';
    return null;
  };
  const whyNotThisToolsRoute = (tool, r) => (KEEP_PAIRING.has(`${tool}	${routeKey(r)}`) ? null : strangerWhy(tool, r));
  const joinedRoutes = (tool) => {
    const rules = operationsOf(world, tool).flatMap((op) => byOperation.get(op) ?? []);
    return world.rows.filter((r) => rules.some((u) => u.method === r.method && u.pattern.test(concrete(r.route))));
  };
  const routesFor = (tool) => {
    const kept = joinedRoutes(tool).filter((r) => whyNotThisToolsRoute(tool, r) === null);
    return kept.length ? kept : world.rows.filter((r) => mapOwner.get(routeKey(r)) === tool);
  };
  const wouldDrop = (tools) => new Set(tools.flatMap((t) => joinedRoutes(t).filter((r) => strangerWhy(t, r) !== null).map((r) => `${t}	${routeKey(r)}`)));
  return { joinedRoutes, whyNotThisToolsRoute, routesFor, wouldDrop };
}

/**
 * `[{ tool, declared, routes }]`: each tool with an audit operation and the routes it is compared with. `declared` are its input-schema keys less
 * the transport ones; each route is the `routeAcceptKeys` row (`keys`/`queryKeys`, or `delegatesTo`, or `unresolved`).
 */
export function keyPairs(world) {
  const { routesFor } = doorPairing(world);
  return [...world.tools.values()].filter((v) => world.MCP_TOOL_OPERATIONS[v.tool.name]).map((v) => ({
    tool: v.tool.name, declared: declaredKeys(v), routes: routesFor(v.tool.name),
  }));
}

/** The parameters a tool declares, less the transport ones (`v` is a `toolValidators` row). */
export const declaredKeys = (v) => Object.keys(v.schema.properties ?? {}).filter((k) => !TRANSPORT.has(k));

/** `KEEP_PAIRING` rows that keep nothing (no stranger's route is dropped for that tool): a problem, as an exception that excuses nothing. */
export function staleKeepRows(world) {
  const would = doorPairing(world).wouldDrop([...world.tools.keys()]);
  return [...KEEP_PAIRING.keys()].filter((k) => !would.has(k));
}

/** The path parameters of a route: `:id` is the key `id`. */
export const pathParams = (r) => [...r.route.matchAll(/:(\w+)/g)].map((m) => m[1]);

/** Every key any of the routes accepts: body keys and query keys together (which one a key arrives in is the route's transport decision), and the path's own parameters. */
export const acceptedKeys = (routes) => new Set(routes.flatMap((r) => [...r.keys, ...(r.queryKeys ?? []), ...pathParams(r)]));

/**
 * The keys a tool declares that none of its routes accepts. A tool's routes must ALL be readable (a union of the readable ones is the wrong answer: a
 * list route that reads its filters field by field is declined and the single-entry route then answers for both), else nothing is said of it.
 */
export function toolOnlyKeys({ declared, routes }) {
  if (!routes.length || routes.some((r) => !r.keys)) return [];
  const accepted = acceptedKeys(routes);
  return declared.filter((k) => !accepted.has(k));
}

/** `[{ key, route }]`: each key a readable route accepts that the tool does not declare (the path's own parameters and the transport keys aside). */
export function routeOnlyKeys({ declared, routes }) {
  const have = new Set([...declared, ...TRANSPORT]);
  return routes.filter((r) => r.keys).flatMap((r) => [...new Set([...r.keys, ...(r.queryKeys ?? [])])]
    .filter((k) => !have.has(k) && !pathParams(r).includes(k)).map((key) => ({ key, route: r })));
}

/**
 * `{ findings, compared, unreadable, delegating }`: the key differences between each tool and its routes, `[{ id: 'tool:param', text }]`.
 * A tool's routes must ALL be readable for the tool-to-route half (a union of the readable ones is the wrong answer: a list route that reads
 * its filters field by field is declined and the single-entry route then answers for both); the route-to-tool half asks every readable route.
 */
export function keyFindings(pairs) {
  const findings = [];
  const seen = new Set();
  const add = (id, text) => { if (!seen.has(id)) { seen.add(id); findings.push({ id, text }); } };
  let compared = 0;
  let unreadable = 0;
  let delegating = 0;
  for (const { tool, declared, routes } of pairs) {
    if (!routes.length) continue;
    if (routes.some((r) => r.delegatesTo)) delegating += 1;
    if (routes.some((r) => !r.keys)) unreadable += 1;
    const readable = routes.filter((r) => r.keys);
    if (!readable.length) continue;
    compared += 1;
    for (const k of toolOnlyKeys({ declared, routes })) add(`${tool}:${k}`, `${tool} declares '${k}' and none of ${readable.map(routeKey).join(', ')} accepts it: the route drops it silently`);
    for (const { key, route } of routeOnlyKeys({ declared, routes })) add(`${tool}:${key}`, `${routeKey(route)} accepts '${key}' and ${tool} does not declare it: a REST caller can say what an MCP caller cannot`);
  }
  return { findings, compared, unreadable, delegating };
}

/**
 * `[{ name, schema }]`: the exported zod schemas that function bodies `texts` parse with (`X.safeParse(` / `X.parse(`) and that describe an
 * OBJECT, the only shape a request body or a tool's arguments have. A scalar schema a helper deep in the call graph applies to some other value
 * (an address, a prefix read from the config) is no route's body schema: counted as one, it made every route that reaches the helper read as
 * "compared" with no parameter to compare, and hid it from the hand-validated count (bundle-269: `PrefixZ` and `NamespaceIriZ`, reached
 * through the effective library entries from every write).
 */
export function bodySchemasIn(texts, zods) {
  const names = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:safeParse|parse)\s*\(/g)) {
      const z = zods.get(m[1]);
      if (z && z.schema && typeof z.schema === 'object' && z.schema.properties && typeof z.schema.properties === 'object') names.add(m[1]);
    }
  }
  return [...names].map((name) => ({ name, schema: zods.get(name).schema }));
}

/**
 * `[{ tool, key, route, delegation, schemas, toolSchema }]` for each capability-map row (`route` the mounted route with its source): `schemas` are `{ name, schema }` of the exported zod schemas the route's handler
 * reaches through the call graph, `delegation` what `delegationOf` says of a route that hands its body to a tool.
 */
export function capabilityPairs(world) {
  return world.CAPABILITIES.map(([, tool, key]) => {
    const [method, path] = key.split(' ');
    const route = world.routes.find((r) => r.method === method && r.path === path);
    const entry = world.tools.get(tool);
    if (!route || !entry) throw new CannotAnswer(`the capability map pairs ${tool} with ${key}, and ${route ? 'no such tool' : 'no such route'} exists`);
    const delegation = world.delegationOf(route.source);
    let schemas = [];
    if (!delegation) {
      const { seen } = world.graph.walkFrom(world.index, world.graph.routeHandlerRoots(world.index, route), { closures: true });
      schemas = bodySchemasIn([...seen].map((k) => world.index.bodies.get(k).body), world.zods);
    }
    return { tool, key, route, delegation, schemas, toolSchema: entry.schema };
  });
}

/**
 * `{ findings, compared, delegating, unreadable }`: for each shared parameter, the differences of `attrs` between the tool's schema and the zod
 * schemas its route parses with, `[{ id: 'tool:param.attr', text }]`. A parameter `BOUND_BY_FIELD` names is held to one bound everywhere by
 * `every-quantity-a-caller-sends-has-a-bound` and is left to it. `unreadable` are routes whose tool states a cap and that validate by hand.
 */
export function attributeFindings(pairs, attrs, boundByField) {
  const findings = [];
  const seen = new Set();
  let compared = 0;
  let delegating = 0;
  const unreadable = [];
  for (const p of pairs) {
    if (p.delegation) { delegating += 1; continue; }
    if (!p.schemas.length) {
      if (Object.entries(p.toolSchema.properties ?? {}).some(([k, v]) => !TRANSPORT.has(k) && !(k in boundByField) && attrs.some((a) => attributeOf(a, p.toolSchema, v, k) !== undefined && a !== 'required'))) unreadable.push(`${p.tool} ${p.key}`);
      continue;
    }
    compared += 1;
    for (const { name, schema } of p.schemas) {
      for (const [param, toolNode] of Object.entries(p.toolSchema.properties ?? {})) {
        const restNode = schema.properties?.[param];
        if (!restNode || TRANSPORT.has(param) || param in boundByField) continue;
        for (const a of attrs) {
          const t = attributeOf(a, p.toolSchema, toolNode, param);
          const r = attributeOf(a, schema, restNode, param);
          if (JSON.stringify(t) === JSON.stringify(r)) continue;
          // A default only one door's schema states is applied in the other's handler, which this reading cannot see: only two stated defaults differ.
          if (a === 'default' && (t === undefined || r === undefined)) continue;
          const id = `${p.tool}:${param}.${a}`;
          if (seen.has(id)) continue;
          seen.add(id);
          findings.push({ id, text: `${id}: the tool says ${JSON.stringify(t)}, ${p.key} (${name}) says ${JSON.stringify(r)}` });
        }
      }
    }
  }
  return { findings, compared, delegating, unreadable };
}
