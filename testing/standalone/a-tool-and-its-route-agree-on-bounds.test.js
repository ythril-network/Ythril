/**
 * A tool and its route agree on every BOUND of a parameter they share (`Q-109`).
 *
 * ## The half the other parity gates leave
 *
 * `mcp-rest-parity` asks whether a capability exists on both doors, and `a-tool-and-its-route-take-the-same-
 * parameters` asks whether they take the same parameter NAMES. Neither asks whether `limit` is 1–200 on one door
 * and 1–1000 on the other — and that is the shape the y-flows convention `convention-ythril-both-doors-same-parameters` names: *"a `400` on one door and a silent default
 * on the other is worse than either alone"*. This compares, per shared parameter, the `minimum` / `maximum` /
 * `minLength` / `maxLength` / `minItems` / `maxItems`, the `enum`, and whether it is required.
 *
 * ## Derived on every axis
 *
 * - **The pairs** are `CAPABILITIES` (`_capability-map.mjs`), the one classification of which route answers which
 *   tool — itself asserted against the mounted routes and the registry, so a row cannot rot.
 * - **The tool's bounds** are its `inputSchema`; **the route's** are the zod schemas its handler reaches, found by
 *   walking the call graph from the handler (`_call-graph.mjs`) for a `<Schema>.safeParse(` / `.parse(` on an
 *   exported schema (`_validator-schemas.mjs`). A schema parsed inside an act the route calls is found the same way.
 * - **A route that hands its body to `callTool`** agrees by construction — the tool's own schema is its validator —
 *   and is detected by `_delegating-routes.mjs`, never listed.
 * - **A field `BOUND_BY_FIELD` names** (`tags`, `edges`, `deleteFields`…) is left to
 *   `every-quantity-a-caller-sends-has-a-bound`, which already holds it to one bound everywhere. Checking it here
 *   too would be the second copy of one assertion.
 *
 * ## What it cannot read, and the case that keeps that honest
 *
 * A route that validates by hand (`if (typeof x !== 'number' || x > 200)`) has no schema to compare. Those whose
 * tool states a bound are counted, and the count may only fall — the same discipline the parameter gate keeps for
 * routes it cannot parse. Most of them validate through a shared function both doors call (`shapeError`,
 * `validateDeleteFields`, `connectionInputError`), which `a-quantity-over-its-bound-is-refused` exercises.
 *
 * Run: node --test testing/standalone/a-tool-and-its-route-agree-on-bounds.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from './_capability-map.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { delegationOf } from './_delegating-routes.mjs';
import { moduleIndex, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { toolValidators, zodValidators } from './_validator-schemas.mjs';
import { BOUND_BY_FIELD } from '../../server/dist/util/request-bounds.js';

/** Keys that are transport on one door (a path segment) and a parameter on the other. */
const TRANSPORT = new Set(['space']);

const BOUND_KEYS = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];

/**
 * Pairs that differ on purpose, each with its reason — never a bare name.
 */
const DIFFER_ON_PURPOSE = new Map([
  ['schema_update:typeSchemas.required',
    'the tool is the meta door as a whole — it writes type schemas AND the other meta fields, and merges — while '
    + '`PUT /api/spaces/:id/schema` is the type-schema half alone; the meta-only half is `PATCH /api/spaces/:id`.'],
]);

/**
 * Routes whose tool states a bound and whose own validation cannot be read. May only FALL: a new route written
 * with a schema is covered the day it lands, and one written by hand adds to this and fails.
 */
const UNREADABLE_CEILING = 33;

/**
 * One node's bounds, normalised so two spellings of the same rule compare equal: an integer's exclusive bound is
 * the next inclusive one, a URL/URI/email format is a non-empty string, and a union's bound is its envelope (the
 * loosest branch), because a union accepts what any branch accepts. A `null` branch is dropped.
 */
function boundsOf(node) {
  if (!node || typeof node !== 'object') return {};
  const branches = (node.anyOf ?? node.oneOf)?.filter(b => b.type !== 'null');
  if (branches?.length) {
    const each = branches.map(boundsOf);
    const out = {};
    for (const k of BOUND_KEYS) {
      if (each.some(b => b[k] === undefined)) continue;
      out[k] = k.startsWith('min') ? Math.min(...each.map(b => b[k])) : Math.max(...each.map(b => b[k]));
    }
    const enums = each.map(b => b.enum);
    if (enums.every(Boolean)) out.enum = [...new Set(enums.flat())].sort();
    return out;
  }
  const out = {};
  for (const k of BOUND_KEYS) if (node[k] !== undefined) out[k] = node[k];
  const integer = [node.type].flat().includes('integer');
  if (node.exclusiveMinimum !== undefined) out.minimum = integer ? node.exclusiveMinimum + 1 : node.exclusiveMinimum;
  if (node.exclusiveMaximum !== undefined) out.maximum = integer ? node.exclusiveMaximum - 1 : node.exclusiveMaximum;
  if (['uri', 'url', 'email'].includes(node.format)) out.minLength = Math.max(out.minLength ?? 0, 1);
  const e = node.enum ?? node.items?.enum;
  if (Array.isArray(e)) out.enum = [...e].sort();
  return out;
}

/** Whether the tool states any bound a comparison could disagree with (transport and BOUND_BY_FIELD aside). */
const statesABound = schema => Object.entries(schema.properties ?? {})
  .some(([k, v]) => !TRANSPORT.has(k) && !(k in BOUND_BY_FIELD) && Object.keys(boundsOf(v)).length > 0);

const TOOLS = new Map(toolValidators().map(v => [v.tool.name, v]));
const ZODS = new Map((await zodValidators()).map(z => [z.name, z]));
const ROUTES = mountedRoutesWithSource();
const INDEX = moduleIndex('server/src');

/** The exported zod schemas a route's handler reaches and parses with. */
function schemasReachedBy(route) {
  const { seen } = walkFrom(INDEX, routeHandlerRoots(INDEX, route), { closures: true });
  const names = new Set();
  for (const key of seen) {
    for (const m of INDEX.bodies.get(key).body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:safeParse|parse)\s*\(/g)) {
      if (ZODS.has(m[1])) names.add(m[1]);
    }
  }
  return [...names];
}

const PAIRS = CAPABILITIES.map(([, toolName, key]) => {
  const [method, path] = key.split(' ');
  const route = ROUTES.find(r => r.method === method && r.path === path);
  const tool = TOOLS.get(toolName);
  assert.ok(route && tool, `CAPABILITIES pairs ${toolName} with ${key}, and ${route ? 'no such tool' : 'no such route'} exists`);
  const delegation = delegationOf(route.source);
  return { toolName, key, route, tool, delegation, schemas: delegation ? [] : schemasReachedBy(route) };
});

/** Every disagreement between a tool and the schemas its route parses with. */
function disagreements() {
  const out = [];
  for (const p of PAIRS.filter(x => x.schemas.length > 0)) {
    const toolSchema = p.tool.schema;
    for (const name of p.schemas) {
      const restSchema = ZODS.get(name).schema;
      for (const [param, toolNode] of Object.entries(toolSchema.properties ?? {})) {
        const restNode = restSchema.properties?.[param];
        if (!restNode || TRANSPORT.has(param) || param in BOUND_BY_FIELD) continue;
        const t = boundsOf(toolNode);
        const r = boundsOf(restNode);
        for (const k of [...BOUND_KEYS, 'enum']) {
          if (JSON.stringify(t[k]) === JSON.stringify(r[k])) continue;
          const id = `${p.toolName}:${param}.${k}`;
          if (!DIFFER_ON_PURPOSE.has(id)) out.push(`${id} — MCP ${JSON.stringify(t[k])}, ${p.key} (${name}) ${JSON.stringify(r[k])}`);
        }
        const tr = (toolSchema.required ?? []).includes(param);
        const rr = (restSchema.required ?? []).includes(param);
        const id = `${p.toolName}:${param}.required`;
        if (tr !== rr && !DIFFER_ON_PURPOSE.has(id)) out.push(`${id} — MCP ${tr}, ${p.key} (${name}) ${rr}`);
      }
    }
  }
  return out;
}

describe('a tool and its route agree on every bound of a shared parameter', () => {
  it('the pairing found its subjects on every axis', () => {
    assert.ok(PAIRS.length >= 60, `only ${PAIRS.length} tool/route pair(s) — the capability map or the route scan broke`);
    assert.ok(PAIRS.filter(p => p.delegation).length >= 3, 'no route found delegating to callTool — the detector broke');
    assert.ok(PAIRS.filter(p => p.schemas.length > 0).length >= 15,
      'too few routes resolved to a zod schema — the call-graph walk or the schema derivation broke');
  });

  it('a delegating route hands over its WHOLE body, so it agrees by construction rather than by luck', () => {
    const impure = PAIRS.filter(p => p.delegation?.impure).map(p => `${p.key} → ${p.delegation.tool}`);
    assert.deepEqual(impure, [], 'a route that delegates to a tool and ALSO reads the body has a second validator nobody compares');
  });

  it('every shared parameter carries the same bounds on both doors', () => {
    const found = disagreements();
    assert.deepEqual(found, [], `${found.length} bound(s) differ by door — make the weaker door refuse what the stronger `
      + `does, in the same words:\n  ${found.join('\n  ')}`);
  });

  it('every sanctioned difference still exists', () => {
    const all = new Set();
    for (const p of PAIRS.filter(x => x.schemas.length > 0)) {
      for (const name of p.schemas) {
        const restSchema = ZODS.get(name).schema;
        for (const param of Object.keys(p.tool.schema.properties ?? {})) {
          if (!restSchema.properties?.[param]) continue;
          if ((p.tool.schema.required ?? []).includes(param) !== (restSchema.required ?? []).includes(param)) all.add(`${p.toolName}:${param}.required`);
          const t = boundsOf(p.tool.schema.properties[param]);
          const r = boundsOf(restSchema.properties[param]);
          for (const k of [...BOUND_KEYS, 'enum']) if (JSON.stringify(t[k]) !== JSON.stringify(r[k])) all.add(`${p.toolName}:${param}.${k}`);
        }
      }
    }
    const stale = [...DIFFER_ON_PURPOSE.keys()].filter(id => !all.has(id));
    assert.deepEqual(stale, [], `sanctioned differences that no longer differ — delete them: ${stale.join(', ')}`);
  });

  it('the routes whose bounds cannot be read only get FEWER', () => {
    const unreadable = PAIRS.filter(p => !p.delegation && p.schemas.length === 0 && statesABound(p.tool.schema));
    assert.ok(unreadable.length <= UNREADABLE_CEILING,
      `${unreadable.length} route(s) whose tool states a bound validate by hand, up from ${UNREADABLE_CEILING}. Give the `
      + `route a schema this gate can read, or delegate it to the tool:\n  ${unreadable.map(p => `${p.toolName} ${p.key}`).join('\n  ')}`);
  });
});

/**
 * Q-624: the fork capability's parameters, read rather than skipped.
 *
 * ## Why the cases above are not enough for it
 *
 * `every shared parameter carries the same bounds` walks the parameters a tool and a route schema BOTH declare. A parameter the route's
 * schema does not declare is not a disagreement to it, it is not looked at: `resolve_fork` could gain `kind`, `ifMatchSeq` and
 * `ifMatchParentSeq` on the tool while `ForkResolveParams` kept its two fields, and every case above would stay green, with the REST door
 * quietly reading those three out of a body by hand. The parameter gate cannot say otherwise either: it reports the resolve route as
 * `unresolved` ("the body is read field by field") and skips it. So the five parameters of the resolve (design rev 4, section 10) are
 * asserted here, on the one derivation that does read the route's validator.
 *
 * - **The pairs** are the capability map's pairs whose route is under `/forks`, derived, with a floor.
 * - **Both directions:** a parameter the tool declares must be in the schema the route parses with, and a parameter that schema declares must be
 *   the tool's (the path's `space` aside), so neither door can offer a parameter the other lacks.
 * - **The set** below is the design's own statement of the resolve (`kind`, `forkId`, `keep`, `ifMatchSeq` and `ifMatchParentSeq`, all required)
 *   and of the list (`kind` optional): a fixture of the rule, not a derivation of it, which is why it is written out.
 * - **`kind`** is judged against `FORKING_FAMILIES` (`sync/upsert-plan.ts`), the one list the design reads every forking kind from, so a fifth
 *   family widens the enum on both doors or this fails.
 */
describe('the fork capability\'s parameters are compared on both doors (Q-624)', () => {
  const FORK_PAIRS = PAIRS.filter(p => /\/forks(\/|$)/.test(p.route.path));
  const RESOLVE_PARAMS = ['kind', 'forkId', 'keep', 'ifMatchSeq', 'ifMatchParentSeq'];
  const resolvePair = FORK_PAIRS.find(p => p.route.method === 'POST');
  const listPair = FORK_PAIRS.find(p => p.route.method === 'GET');

  /** The properties and required list of every schema the route parses with, merged: that is what the door accepts. */
  const doorOf = pair => {
    const properties = {};
    const required = new Set();
    for (const name of pair.schemas) {
      const s = ZODS.get(name).schema;
      Object.assign(properties, s.properties ?? {});
      for (const r of s.required ?? []) required.add(r);
    }
    return { properties, required };
  };

  it('finds both fork pairs, and each parses with a schema this gate can read', () => {
    assert.ok(resolvePair && listPair, `the capability map pairs ${FORK_PAIRS.length} route(s) under /forks; list and resolve are both expected`);
    for (const p of FORK_PAIRS) {
      assert.ok(p.delegation || p.schemas.length > 0,
        `${p.toolName} <-> ${p.key} parses with no schema this gate can read, so none of its parameters is compared by anything`);
    }
  });

  it('the resolve takes kind, forkId, keep, ifMatchSeq and ifMatchParentSeq on both doors, every one required', () => {
    assert.ok(resolvePair, 'no resolve pair');
    const door = doorOf(resolvePair);
    const toolHas = Object.keys(resolvePair.tool.schema.properties ?? {});
    const toolRequired = new Set(resolvePair.tool.schema.required ?? []);
    const problems = [];
    for (const param of RESOLVE_PARAMS) {
      if (!toolHas.includes(param)) problems.push(`MCP ${resolvePair.toolName} does not declare '${param}'`);
      else if (!toolRequired.has(param)) problems.push(`MCP ${resolvePair.toolName} does not require '${param}'`);
      if (!(param in door.properties)) problems.push(`${resolvePair.key} parses with no schema that declares '${param}' (${resolvePair.schemas.join(', ')})`);
      else if (!door.required.has(param)) problems.push(`${resolvePair.key}: its schema does not require '${param}'`);
    }
    assert.deepEqual(problems, [], `the resolve's parameters differ by door:\n  ${problems.join('\n  ')}`);
  });

  it('no fork parameter exists on one door only, in either direction', () => {
    const problems = [];
    for (const p of FORK_PAIRS) {
      if (p.delegation) continue;
      const door = doorOf(p);
      const tool = Object.keys(p.tool.schema.properties ?? {}).filter(k => !TRANSPORT.has(k));
      const rest = Object.keys(door.properties).filter(k => !TRANSPORT.has(k));
      for (const k of tool) if (!rest.includes(k)) problems.push(`MCP ${p.toolName} declares '${k}', ${p.key} parses with no schema that does`);
      for (const k of rest) if (!tool.includes(k)) problems.push(`${p.key} (${p.schemas.join(', ')}) declares '${k}', MCP ${p.toolName} does not`);
    }
    assert.deepEqual(problems, [], problems.join('\n  '));
  });

  it('kind is one enum on both doors with a member per forking family; required on the resolve, optional on the list', async () => {
    const { FORKING_FAMILIES } = await import('../../server/dist/sync/upsert-plan.js');
    assert.ok(Array.isArray(FORKING_FAMILIES) && FORKING_FAMILIES.length >= 4,
      'sync/upsert-plan.js exports no FORKING_FAMILIES of at least the four families (facts, entities, chrono, edges) the design forks');
    assert.ok(resolvePair && listPair);
    for (const [pair, mustRequire] of [[resolvePair, true], [listPair, false]]) {
      const tool = pair.tool.schema.properties?.kind;
      const rest = doorOf(pair).properties.kind;
      assert.ok(tool, `MCP ${pair.toolName} declares no 'kind'`);
      assert.ok(rest, `${pair.key} parses with no schema that declares 'kind'`);
      const toolEnum = boundsOf(tool).enum;
      const restEnum = boundsOf(rest).enum;
      assert.ok(toolEnum && restEnum, `'kind' must be an enum on both doors (MCP ${JSON.stringify(toolEnum)}, REST ${JSON.stringify(restEnum)}): an id is unique per collection only, so a free string is a guess`);
      assert.deepEqual(toolEnum, restEnum, `'kind' differs by door for ${pair.toolName}`);
      assert.equal(toolEnum.length, FORKING_FAMILIES.length, `the 'kind' enum has ${toolEnum.length} member(s) and there are ${FORKING_FAMILIES.length} forking families`);
      assert.equal((pair.tool.schema.required ?? []).includes('kind'), mustRequire, `MCP ${pair.toolName}: 'kind' ${mustRequire ? 'is required' : 'is optional'}`);
      assert.equal(doorOf(pair).required.has('kind'), mustRequire, `${pair.key}: 'kind' ${mustRequire ? 'is required' : 'is optional'}`);
    }
  });

  it('ifMatchSeq and ifMatchParentSeq are bounded integers on both doors, and the same bounds', () => {
    assert.ok(resolvePair);
    const door = doorOf(resolvePair).properties;
    for (const param of ['ifMatchSeq', 'ifMatchParentSeq']) {
      const tool = resolvePair.tool.schema.properties?.[param];
      assert.ok(tool, `MCP ${resolvePair.toolName} declares no '${param}'`);
      assert.ok(door[param], `${resolvePair.key} parses with no schema that declares '${param}'`);
      for (const [side, node] of [['MCP', tool], ['REST', door[param]]]) {
        assert.ok([node.type].flat().includes('integer'), `${side} '${param}' is not an integer`);
        const b = boundsOf(node);
        assert.ok(b.minimum !== undefined && b.maximum !== undefined, `${side} '${param}' states no minimum and maximum: a version is a bounded number`);
      }
      assert.deepEqual(boundsOf(tool), boundsOf(door[param]), `'${param}' is bounded differently by door`);
    }
  });
});
