/**
 * A tool and its route agree on every BOUND of a parameter they share (`Q-109`).
 *
 * ## The half the other parity gates leave
 *
 * `mcp-rest-parity` asks whether a capability exists on both doors, and `a-tool-and-its-route-take-the-same-
 * parameters` asks whether they take the same parameter NAMES. Neither asks whether `limit` is 1–200 on one door
 * and 1–1000 on the other — and that is the shape `CLAUDE.md` names: *"a `400` on one door and a silent default
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

/** Keys that are transport on one door (a path segment, a query narrowing) and a parameter on the other. */
const TRANSPORT = new Set(['space', 'targetSpace']);

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
